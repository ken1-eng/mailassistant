/**
 * 判定ログ（スプレッドシート）。全判定を残す。これが検証の土台になる。
 *
 * トリアージのログは既存スクリプトと同じスプレッドシート（LOG_SHEET_ID）の先頭シートに、
 * 同じ列で書く。予定登録のログは同じスプレッドシートの別シートに書く。
 *
 * 「自己判定」列を手で埋めていくと、自分の感覚とシステムの判定のズレがそのまま教師データになる。
 */

const LOG_HEADERS = [
  '受信日時', '送信者', '件名', 'スコア', '判定', '自己判定',
  '分類', '分類確信度', '緊急度', '緊急度確信度', '期限日数',
  '要返信', '名指し', '期限あり', '金銭', 'トラブル', '私信', '自動送信',
];

const CAL_LOG_HEADERS = [
  '記録日時',
  'モード',
  '受信日時',
  '送信者',
  '件名',
  'has_schedule',
  'i_participate',
  'schedule_type',
  '抽出した開始日時',
  '抽出した件名',
  '既存予定の件数',
  '照合した既存予定',
  'relation',
  '実行した動作',
  '理由',
  '補足',
  '自己判定',
  'messageId',
];

function logSpreadsheet_() {
  const id = prop_('LOG_SHEET_ID');
  if (id) {
    try {
      return SpreadsheetApp.openById(id);
    } catch (e) {
      /* 消されていたら作り直す */
    }
  }
  const ss = SpreadsheetApp.create(CONFIG.LOG_SHEET_NAME);
  const sheet = ss.getSheets()[0];
  sheet.appendRow(LOG_HEADERS);
  sheet.getRange(1, 1, 1, LOG_HEADERS.length).setFontWeight('bold');
  sheet.setFrozenRows(1);
  setProp_('LOG_SHEET_ID', ss.getId());
  console.log('ログシートを作成しました: ' + ss.getUrl());
  return ss;
}

function getLogSheet_() {
  return logSpreadsheet_().getSheets()[0];
}

function getCalLogSheet_() {
  const ss = logSpreadsheet_();
  let sh = ss.getSheetByName(CONFIG.CAL_LOG_SHEET_NAME);
  if (!sh) {
    // 末尾に追加する。先頭シートはトリアージのログのまま
    sh = ss.insertSheet(CONFIG.CAL_LOG_SHEET_NAME, ss.getSheets().length);
    sh.appendRow(CAL_LOG_HEADERS);
    sh.getRange(1, 1, 1, CAL_LOG_HEADERS.length).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}

function r2_(v) {
  return typeof v === 'number' ? Math.round(v * 100) / 100 : '';
}

function fmtChoice_(c) {
  if (!c || c.choice === null || c.choice === undefined) return '';
  return typeof c.confidence === 'number' ? `${c.choice} (${r2_(c.confidence)})` : c.choice;
}

function logToSheet_(mail, a, result) {
  getLogSheet_().appendRow([
    mail.date,
    mail.from,
    mail.subject,
    result.score,
    result.bucket,
    '', // 自己判定：ここは手で埋める
    result.category || '',
    r2_(result.categoryConf),
    r2_(a.urgency && a.urgency.score),
    r2_(a.urgency && a.urgency.confidence),
    result.deadlineDays === null || result.deadlineDays === undefined ? '' : result.deadlineDays,
    r2_(a.needs_reply),
    r2_(a.addressed_to_me),
    r2_(a.has_deadline),
    r2_(a.involves_money),
    r2_(a.is_trouble),
    r2_(a.is_personal),
    r2_(a.is_automated),
  ]);
}

function logCalendar_(mode, mail, a, row) {
  getCalLogSheet_().appendRow([
    new Date(),
    mode,
    mail.date,
    mail.from,
    mail.subject,
    r2_(a.has_schedule),
    r2_(a.i_participate),
    fmtChoice_(a.schedule_type),
    row.ev ? formatJst_(row.ev.start, row.ev.allDay) : '',
    row.ev ? row.ev.title : '',
    row.existingCount === null ? '' : row.existingCount,
    row.matched || '',
    row.relation || '',
    row.action,
    row.reason || '',
    row.note || '',
    '', // 自己判定：ここは手で埋める
    mail.id,
  ]);
}

/** ログシートのURLを表示する */
function showLogSheet() {
  const id = prop_('LOG_SHEET_ID');
  console.log(id ? SpreadsheetApp.openById(id).getUrl() : 'まだ作成されていません');
}
