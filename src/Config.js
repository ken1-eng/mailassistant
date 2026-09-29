/**
 * 設定値。
 *
 * 秘密情報や環境ごとに変わる値はスクリプトプロパティに置く（README参照）。
 * ここにあるのはコードと一緒にレビューされるべき値（閾値・上限・ラベル名）。
 * 閾値はすべて暫定値。ログシートの「自己判定」列を埋めて分布を見てから決める。
 */
const CONFIG = {
  TRIAGE: {
    THRESHOLD_HIGH: 65, // 以上で 01_即対応
    THRESHOLD_MID: 35, // 以上で 02_今日中。未満は無印
    LABEL_HIGH: '01_即対応',
    LABEL_MID: '02_今日中',
    MARKER: '_jev',
  },

  CAL: {
    MARKER: '_cal', // トリアージの _jev とは別。予定判定だけ未実施の状態を区別する
    PROVISIONAL_CALENDAR: 'Jev仮登録',
    MATCH_WINDOW_HOURS: 3, // ④ 候補時刻の前後何時間を照合するか
    DEFAULT_DURATION_MIN: 60, // 終了時刻が書かれていないときの長さ
    CANCEL_PREFIX: '【中止】',
    THRESHOLDS: {
      HAS_SCHEDULE: 0.8, // 高めにして取りこぼす方に倒す
      I_PARTICIPATE: 0.6,
      SCHEDULE_TYPE_CONFIDENCE: 0.7, // 未満なら通知のみ
      SAME_EVENT: 0.5, // 以上なら新規登録しない（迷ったら止める）
      RELATION_CONFIDENCE: 0.7, // 未満なら更新・中止印を付けず通知のみ
    },
  },

  LIMITS: {
    PER_RUN: 20, // Apps Script の6分制限
    PER_DAY: 100, // 暴走を止める
    BODY_CHARS: 3000,
    RUN_TIME_BUDGET_MS: 4.5 * 60 * 1000,
  },

  LOG: {
    TRIAGE_SHEET: 'triage_log',
    CAL_SHEET: 'calendar_log',
  },

  TRIGGER_MINUTES: 5,
  TZ_OFFSET_HOURS: 9, // 日付計算は日本時間固定（夏時間なし）
};

/**
 * カレンダー登録の段階（要件定義「実装順序と受け入れ条件」に対応）。
 * スクリプトプロパティ CAL_STAGE で切り替える。
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
  return String(prop_('INTERNAL_DOMAINS', ''))
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}
