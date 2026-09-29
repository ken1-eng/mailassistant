/**
 * 判定ログ（スプレッドシート）。
 *
 * 「自己判定」列は手で埋める。自分の感覚とシステムの判定のズレがそのまま教師データになり、
 * 閾値はこの分布を見てから決める。
 */

const TRIAGE_LOG_HEADERS = [
  '記録日時',
  'モード',
  '受信日時',
  '送信者',
  '件名',
  '自己判定（高/中/低）',
  'スコア',
  'ラベル',
  '社外',
  '期限まで日数',
  'needs_reply',
  'has_deadline',
  'addressed_to_me',
  'involves_money',
  'is_trouble',
  'is_personal',
  'is_automated',
  'urgency',
  'category',
  '宛先人数',
  'messageId',
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

function logSpreadsheet_(createIfMissing) {
  const id = prop_('LOG_SPREADSHEET_ID');
  if (id) return SpreadsheetApp.openById(id);
  if (!createIfMissing) throw new Error('LOG_SPREADSHEET_ID が未設定。setup() を実行する');
  const ss = SpreadsheetApp.create('Jev メール判定ログ');
  setProp_('LOG_SPREADSHEET_ID', ss.getId());
  return ss;
}

function logSheet_(name, headers) {
  const ss = logSpreadsheet_(false);
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.appendRow(headers);
    sh.setFrozenRows(1);
  }
  return sh;
}

function fmtNum_(v) {
  return v === null || v === undefined ? '' : Math.round(v * 100) / 100;
}

function fmtChoice_(c) {
  if (!c || c.choice === null || c.choice === undefined) return '';
  return c.confidence === null || c.confidence === undefined ? c.choice : `${c.choice} (${fmtNum_(c.confidence)})`;
}

function fmtScore_(s) {
  if (!s || s.score === null || s.score === undefined) return '';
  return s.confidence === null || s.confidence === undefined ? fmtNum_(s.score) : `${fmtNum_(s.score)} (${fmtNum_(s.confidence)})`;
}

function logTriage_(mode, mail, a, r) {
  logSheet_(CONFIG.LOG.TRIAGE_SHEET, TRIAGE_LOG_HEADERS).appendRow([
    new Date(),
    mode,
    mail.date,
    mail.from,
    mail.subject,
    '',
    r.score,
    r.label || '',
    r.isExternal ? '社外' : '社内',
    r.deadlineDays === null ? '' : r.deadlineDays,
    fmtNum_(a.needs_reply),
    fmtNum_(a.has_deadline),
    fmtNum_(a.addressed_to_me),
    fmtNum_(a.involves_money),
    fmtNum_(a.is_trouble),
    fmtNum_(a.is_personal),
    fmtNum_(a.is_automated),
    fmtScore_(a.urgency),
    fmtChoice_(a.category),
    mail.recipientCount,
    mail.id,
  ]);
}

function logCalendar_(mode, mail, a, row) {
  logSheet_(CONFIG.LOG.CAL_SHEET, CAL_LOG_HEADERS).appendRow([
    new Date(),
    mode,
    mail.date,
    mail.from,
    mail.subject,
    fmtNum_(a.has_schedule),
    fmtNum_(a.i_participate),
    fmtChoice_(a.schedule_type),
    row.ev ? formatJst_(row.ev.start, row.ev.allDay) : '',
    row.ev ? row.ev.title : '',
    row.existingCount === null ? '' : row.existingCount,
    row.matched || '',
    row.relation || '',
    row.action,
    row.reason || '',
    row.note || '',
    '',
    mail.id,
  ]);
}
