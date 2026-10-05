/**
 * 設定値。
 *
 * ① トリアージの値とスクリプトプロパティ名は、稼働中の既存スクリプト（gmail-triage-jev.gs）と
 * 同じにしてある。同じ Apps Script プロジェクトに入れ替えれば、開始日・日次カウント・ログシートを
 * そのまま引き継ぐ。
 *
 * スクリプトプロパティ
 *   TYPESAFE_API_KEY   Jev の API キー（必須）
 *   START_DATE         開始日 yyyy/MM/dd。setup() が入れる
 *   DAILY_COUNT        1日あたり上限のカウンタ（JSON）
 *   LOG_SHEET_ID       判定ログのスプレッドシート。setup() が作る
 *   INTERNAL_DOMAINS   社内ドメイン（カンマ区切り）。CONFIG.INTERNAL_DOMAINS より優先
 *   CAL_STAGE          カレンダー登録の段階 0〜5。既定 0（トリアージのみ）
 *   ANTHROPIC_API_KEY  ③ 抽出用（段階2以上で必須）
 *   CLAUDE_MODEL       ③ のモデル。既定 claude-opus-5-5
 *   NOTIFY_EMAIL       「通知のみ」を送るアドレス。未設定ならログのみ
 *
 * 閾値はすべて暫定値。ログシートの「自己判定」列を埋めて分布を見てから決める。
 */
const CONFIG = {
  // 何を拾うか（Gmail検索クエリ）。after: は開始日から自動で付ける
  TRIAGE_QUERY: 'is:unread -category:promotions -category:social',
  // 予定判定は既読でも拾う（予定の見落としを避ける。二重処理は _cal マーカーで防ぐ）
  CAL_QUERY: '-category:promotions -category:social -in:chats -in:drafts',

  MAX_PER_DAY: 100, // 溜まった未読を一気に舐めないための保険
  MAX_THREADS: 20, // 1回の実行で処理する最大スレッド数（Apps Script は6分で強制終了する）
  RUN_TIME_BUDGET_MS: 4.5 * 60 * 1000,

  // 自分の社内ドメイン（@は付けない）。スクリプトプロパティ INTERNAL_DOMAINS があればそちらを使う
  INTERNAL_DOMAINS: [],

  // 本文をどこまで送るか（文字数）。長文を全部送っても精度は上がらず金だけ増える
  BODY_LIMIT: 3000,

  // 緊急・要対応・それ以外の3段階。それ以外（LOW）はラベルを付けない。ラベルが付いている＝見るべきもの
  //   HIGH   01_緊急   対応が必要で急ぐ（65点以上）
  //   MEDIUM 02_要対応 自分が対応すべき。急ぎかは問わない（35点以上、または名指しの依頼）
  LABELS: {
    HIGH: '01_緊急',
    MEDIUM: '02_要対応',
    PROCESSED: '_jev', // 二重処理を防ぐための内部用マーカー
    CAL_PROCESSED: '_cal', // 予定判定済み。トリアージだけ済んだ状態を区別する
  },

  THRESHOLD_HIGH: 65,
  THRESHOLD_MEDIUM: 35,

  // 名指しの依頼（要返信も名指しもこれ以上）は、急ぎでなくても少なくとも「要対応」にする。
  // 緊急度を掛け算にしているため、急ぎでない名指しの依頼は点数だけでは 35 点に届かない
  DIRECT_REQUEST: 0.8,

  // ラベル名を変えたときに移し替える対応表（renameLabels() で使う）
  OLD_LABELS: { '01_即対応': '01_緊急', '02_今日中': '02_要対応' },

  // これ未満の確信度の判定は「不明」として弱く扱う
  MIN_CONFIDENCE: 0.5,

  LOG_SHEET_NAME: 'Jevメール判定ログ',
  CAL_LOG_SHEET_NAME: '予定登録ログ', // 同じスプレッドシートの別シート

  CAL: {
    PROVISIONAL_CALENDAR: 'Jev仮登録',
    MATCH_WINDOW_HOURS: 3, // ④ 候補時刻の前後何時間を照合するか
    DEFAULT_DURATION_MIN: 60, // 終了時刻が書かれていないときの長さ
    CANCEL_PREFIX: '【中止】',
    THRESHOLDS: {
      HAS_SCHEDULE: 0.8, // 高めにして取りこぼす方に倒す
      I_PARTICIPATE: 0.6,
      PERSONALLY_INVITED: 0.6, // メーリングリスト経由のときだけ使う
      SCHEDULE_TYPE_CONFIDENCE: 0.7, // 未満なら通知のみ
      SAME_EVENT: 0.5, // 以上なら新規登録しない（迷ったら止める）
      RELATION_CONFIDENCE: 0.7, // 未満なら更新・中止印を付けず通知のみ
    },
  },

  TRIGGER_MINUTES: 5,
  TZ_OFFSET_HOURS: 9, // 日付計算は日本時間固定（夏時間なし）
};

const JEV_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
const JEV_MODEL = 'jev-latest';

/**
 * カレンダー登録の段階（要件定義「実装順序と受け入れ条件」に対応）。
 */
const CAL_STAGE = {
  OFF: 0,
  JUDGE: 1, // ② 予定判定のみ記録
  EXTRACT: 2, // ②＋③ 抽出まで記録
  MATCH: 3, // ②〜⑤ 照合まで記録
  PROVISIONAL: 4, // 仮登録カレンダーへ書き込み
  MAIN: 5, // 本カレンダーへ書き込み
};

function prop_(key, fallback) {
  const v = PropertiesService.getScriptProperties().getProperty(key);
  return v === null || v === '' ? fallback : v;
}

function setProp_(key, value) {
  PropertiesService.getScriptProperties().setProperty(key, String(value));
}

function calStage_() {
  const n = Number(prop_('CAL_STAGE', '0'));
  return Number.isFinite(n) ? Math.max(0, Math.min(5, Math.floor(n))) : 0;
}

function internalDomains_() {
  const p = prop_('INTERNAL_DOMAINS', '');
  const list = p ? p.split(',') : CONFIG.INTERNAL_DOMAINS;
  return list.map((s) => String(s).trim().toLowerCase()).filter(Boolean);
}
