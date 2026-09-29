/**
 * Gmail × Jev メールトリアージ ＋ メール→カレンダー自動登録
 * ---------------------------------------------------------------
 *   setup()           初回に1回。ラベル・ログシート・開始日・5分おきトリガーを用意する
 *   triageInbox()     トリガーから呼ばれる本処理
 *   dryRun()          ラベルもマーカーも付けず、カレンダーにも書かず、採点と記録だけ行う
 *   previewCalendar() 直近7日のメールでカレンダー登録がどうなるかを見る（書き込みなし）
 *   stop()            自動実行を止める
 *   countTargets()    今の設定で何件が対象になるかを数えるだけ
 *   resetDailyCount() 1日あたり上限のカウントをリセットする
 *   rerunAll()        トリアージの判定をやり直す（_jev マーカーを外す）
 *   showLogSheet()    ログシートのURLを表示する
 *
 * 1通につき Jev へのリクエストは1回（① トリアージ9問＋② 予定判定3問をまとめる）。
 * 何問詰めても追加の待ち時間はほぼゼロなので、質問は惜しまない。
 *
 * 【ラベルの色】Apps Scriptからは色を設定できないので、Gmailの画面で手動で付ける。
 */

function setup() {
  ensureLabels_();
  getLogSheet_();
  if (calStage_() >= CAL_STAGE.JUDGE) getCalLogSheet_();
  if (calStage_() >= CAL_STAGE.PROVISIONAL) provisionalCalendar_(true);

  // 開始日を今日に固定する。これより前のメールは永久に対象外
  if (!prop_('START_DATE')) {
    const today = jstYmd_(new Date(), '/');
    setProp_('START_DATE', today);
    console.log(`開始日を ${today} に設定しました。これより前のメールは処理しません。`);
  } else {
    console.log(`開始日は ${prop_('START_DATE')} のままです。`);
  }

  // 既存トリガーを消してから登録（重複防止）
  deleteTriggers_();
  ScriptApp.newTrigger('triageInbox').timeBased().everyMinutes(CONFIG.TRIGGER_MINUTES).create();

  console.log(`セットアップ完了。5分おきに triageInbox が動きます（カレンダー登録の段階: ${calStage_()}）。`);
}

/** 自動実行を止める。ラベルやログはそのまま残る */
function stop() {
  const n = deleteTriggers_();
  console.log(`トリガーを ${n} 件削除しました。判定は止まります。`);
}

function deleteTriggers_() {
  let n = 0;
  ScriptApp.getProjectTriggers().forEach((t) => {
    if (t.getHandlerFunction() === 'triageInbox') {
      ScriptApp.deleteTrigger(t);
      n++;
    }
  });
  return n;
}

function triageInbox() {
  run_(false);
}

/**
 * 閾値を決める前に、まずこれで手元の感覚と合っているか確かめる。
 * ラベルは付けず、ログに採点結果だけ出す。
 */
function dryRun() {
  run_(true);
}

/**
 * 今届いているメールで、カレンダー登録が「どうなるか」を見る。
 * CAL_STAGE に関係なく ④⑤ の照合まで行うが、カレンダー・ラベル・マーカーには一切書かない。
 * 対象は直近7日（処理済みかどうかは問わない）。日次上限にも数えない。
 * 結果は実行ログに一覧で出し、予定登録ログにもモード「preview」で残す。
 */
function previewCalendar() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10 * 1000)) return;
  try {
    const startedAt = Date.now();
    const ctx = { dry: true, stage: CAL_STAGE.MATCH, me: myAddresses_(), domains: internalDomains_() };
    const threads = GmailApp.search(CONFIG.CAL_QUERY + ' newer_than:7d', 0, CONFIG.MAX_THREADS);
    const lines = [];

    threads.forEach((thread) => {
      if (Date.now() - startedAt > CONFIG.RUN_TIME_BUDGET_MS) return;
      const msg = pickMessage_(thread, ctx.me);
      if (!msg) return;
      const mail = toMail_(msg, thread, ctx.domains);
      try {
        const answers = jevAsk_(buildState_(mail), SCHEDULE_QUESTIONS);
        const row = calendarOne_(mail, answers, ctx);
        logCalendar_('preview', mail, answers, row);
        lines.push({ row: row, text: previewLine_(mail, row) });
      } catch (e) {
        lines.push({ row: { action: 'error' }, text: `⚠️ エラー | ${mail.subject} | ${e.message}` });
      }
    });

    // 予定として扱われたものを上に
    const rank = (a) => (/^would:/.test(a) ? 0 : a === 'notify' || a === 'error' ? 1 : 2);
    lines.sort((x, y) => rank(x.row.action) - rank(y.row.action));
    console.log(`直近7日の ${lines.length} 通（カレンダーには書き込んでいません）`);
    lines.forEach((l) => console.log(l.text));
    if (Date.now() - startedAt > CONFIG.RUN_TIME_BUDGET_MS) console.log('時間切れのため途中まで');
  } finally {
    lock.releaseLock();
  }
}

const PREVIEW_ACTIONS = {
  'would:create': '📅 新規登録する',
  'would:none': '✅ 登録済みなので何もしない',
  'would:update': '🔁 既存予定の日時を更新する',
  'would:mark_cancelled': '🚫 既存予定に【中止】を付ける',
  'would:notify': '🔔 迷うので通知のみ',
  'would:skip': '― 何もしない',
  notify: '🔔 通知のみ',
  error: '⚠️ エラー',
  skip: '― 予定ではない',
};

const PREVIEW_REASONS = {
  no_schedule: '予定の連絡ではない',
  not_participant: '自分は参加者ではない',
  ml_not_personal: 'ML の一斉連絡で、自分が出席者か分からない',
  not_schedule: '予定ではない',
  proposal: '日程調整中（候補提示）',
  low_confidence_type: '予定の種類の判定が曖昧',
  no_datetime: '日時を抽出できなかった',
  no_existing: '近くに既存予定なし',
  all_unrelated: '近くの予定はすべて別件',
  already_registered: '同じ予定が既にある',
  rescheduled: '日時変更',
  cancelled: '中止',
  cancel_without_existing: '中止連絡だが対象の予定がない',
  cancel_without_match: '中止連絡だが対象の予定がない',
  relation_cannot_tell: '既存予定との関係が判断できない',
  low_confidence_relation: '既存予定との関係の判定が曖昧',
};

function previewLine_(mail, row) {
  const parts = [PREVIEW_ACTIONS[row.action] || row.action, mail.subject.slice(0, 40)];
  if (row.ev) parts.push(`${formatJst_(row.ev.start, row.ev.allDay)} ${row.ev.title}`);
  if (row.matched) parts.push('既存: ' + row.matched);
  parts.push(PREVIEW_REASONS[row.reason] || row.reason || '');
  if (row.note) parts.push(row.note);
  return parts.filter(Boolean).join(' | ');
}

function run_(dry) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10 * 1000)) return; // 前回の実行がまだ終わっていない
  try {
    runLocked_(dry);
  } finally {
    lock.releaseLock();
  }
}

function runLocked_(dry) {
  const startedAt = Date.now();
  const stage = calStage_();

  const budget = dry ? CONFIG.MAX_THREADS : remainingToday_();
  if (budget <= 0) {
    console.log(`本日の上限 ${CONFIG.MAX_PER_DAY} 件に達しています。処理をスキップします。`);
    return;
  }
  const limit = Math.min(CONFIG.MAX_THREADS, budget);
  const targets = findTargets_(stage, dry, limit);
  const ctx = { dry: dry, stage: stage, me: myAddresses_(), domains: internalDomains_(), ranking: [] };

  let done = 0;
  let failed = 0;
  for (let i = 0; i < targets.length; i++) {
    if (Date.now() - startedAt > CONFIG.RUN_TIME_BUDGET_MS) {
      console.log('実行時間の上限に近づいたので残りは次回');
      break;
    }
    try {
      processThread_(targets[i], ctx);
      done++;
    } catch (e) {
      // マーカーを付けずに残すので次回また拾う
      console.error(`失敗: ${targets[i].thread.getFirstMessageSubject()} / ${e.message}`);
      failed++;
    }
  }

  if (dry) {
    // 点数順に並べる。絶対値ではなく「並び順」が自分の感覚と合うかを見る
    ctx.ranking.sort((x, y) => y.score - x.score);
    ctx.ranking.forEach((r) => console.log(`${r.score}点 [${r.bucket}] ${r.subject.slice(0, 50)}`));
    console.log('--- 詳細はログシートを見てください（showLogSheet で URL 表示）---');
    return;
  }

  // 失敗も数える。同じメールで失敗し続けても1日の上限で止まる
  consumeToday_(done + failed);
  console.log(`処理 ${done}件 / 失敗 ${failed}件（本日の残り ${remainingToday_()}件）`);
}

/**
 * 処理対象のスレッドを集める。
 * トリアージは未読のみ（既存どおり）。予定判定は既読でも対象にする。
 * 処理済みマーカーは検索クエリで除外する（検索後に飛ばすと、未読のまま残った処理済みスレッドが
 * 1回あたりの枠を埋め続けて新着が処理されなくなる）。
 */
function findTargets_(stage, dry, limit) {
  const after = ' after:' + startDate_(dry);
  const needCal = stage >= CAL_STAGE.JUDGE;
  const map = {};
  const add = (threads, key) =>
    threads.forEach((t) => {
      const id = t.getId();
      if (!map[id]) map[id] = { thread: t, needTriage: false, needCal: false };
      map[id][key] = true;
    });

  const triageMark = dry ? '' : ` -label:${CONFIG.LABELS.PROCESSED}`;
  const calMark = dry ? '' : ` -label:${CONFIG.LABELS.CAL_PROCESSED}`;
  add(GmailApp.search(CONFIG.TRIAGE_QUERY + after + triageMark, 0, limit), 'needTriage');
  if (needCal) add(GmailApp.search(CONFIG.CAL_QUERY + after + calMark, 0, limit), 'needCal');

  return Object.keys(map)
    .map((k) => map[k])
    .slice(0, limit);
}

function startDate_(dry) {
  const start = prop_('START_DATE');
  if (start) return start.replace(/-/g, '/');
  if (dry) return jstYmd_(new Date(Date.now() - 3 * 86400000), '/');
  throw new Error('開始日が未設定です。先に setup() を実行してください。');
}

/** 今の設定で何件が対象になるかを、処理せずに数えるだけ */
function countTargets() {
  const after = ' after:' + startDate_(false);
  const triage = GmailApp.search(CONFIG.TRIAGE_QUERY + after + ` -label:${CONFIG.LABELS.PROCESSED}`, 0, 500);
  console.log(`トリアージ対象: ${triage.length}件（500で打ち切り）`);
  if (calStage_() >= CAL_STAGE.JUDGE) {
    const cal = GmailApp.search(CONFIG.CAL_QUERY + after + ` -label:${CONFIG.LABELS.CAL_PROCESSED}`, 0, 500);
    console.log(`予定判定対象: ${cal.length}件（500で打ち切り）`);
  }
  console.log(`本日の残り処理枠: ${remainingToday_()}件`);
}

function processThread_(target, ctx) {
  const thread = target.thread;
  const msg = pickMessage_(thread, ctx.me);
  if (!msg) {
    // 自分が送ったメールだけのスレッドなど。判定対象がないので処理済みにする
    if (!ctx.dry) markDone_(thread, target);
    return;
  }

  const mail = toMail_(msg, thread, ctx.domains);
  const questions = []
    .concat(target.needTriage ? TRIAGE_QUESTIONS : [])
    .concat(target.needCal ? SCHEDULE_QUESTIONS : []);
  const answers = jevAsk_(buildState_(mail), questions);

  if (target.needTriage) {
    const r = triageOne_(mail, answers);
    if (!ctx.dry) {
      const labelName = CONFIG.LABELS[r.bucket]; // LOW はラベルを付けない
      if (labelName) thread.addLabel(label_(labelName));
      if (r.bucket === 'HIGH') notifyUrgent_(mail, r);
    }
    logToSheet_(mail, answers, r);
    ctx.ranking.push({ score: r.score, bucket: r.bucket, subject: mail.subject });
    console.log(`[${r.bucket}] ${mail.subject} (score ${r.score} / ${r.category})`);
  }

  if (target.needCal) {
    const row = calendarOne_(mail, answers, ctx);
    logCalendar_(ctx.dry ? 'dry-run' : '本番', mail, answers, row);
  }

  if (!ctx.dry) markDone_(thread, target);
}

function markDone_(thread, target) {
  if (target.needTriage) thread.addLabel(label_(CONFIG.LABELS.PROCESSED));
  if (target.needCal) thread.addLabel(label_(CONFIG.LABELS.CAL_PROCESSED));
}

function triageOne_(mail, a) {
  // 期限の日数は has_deadline が立ったときだけ計算する
  const deadlineDays = a.has_deadline > 0.5 ? daysUntilDeadline_(mail.fullBody, mail.date) : null;
  const r = scoreTriage_(a, { deadlineDays: deadlineDays, isExternal: mail.isExternal });
  r.deadlineDays = deadlineDays;
  return r;
}

/**
 * ②〜⑥。段階（CAL_STAGE）より先には進まない。dry-run と段階3以下では何も書き込まない。
 */
function calendarOne_(mail, a, ctx) {
  const row = { ev: null, existingCount: null, matched: null, relation: null, action: '', reason: '', note: '' };
  const writes = !ctx.dry && ctx.stage >= CAL_STAGE.PROVISIONAL;

  // ② 予定を含むか
  const gate = scheduleGate_(a, { isMailingList: mail.isMailingList });
  row.reason = gate.reason;
  if (mail.isMailingList) row.note = `ML personally_invited=${r2_(a.personally_invited)}`;
  if (!gate.proceed) {
    row.action = gate.notifyOnly ? 'notify' : 'skip';
    if (gate.notifyOnly && writes) notifyCalendar_(mail, null, gate.reason);
    return row;
  }
  if (ctx.stage < CAL_STAGE.EXTRACT) {
    row.action = 'judged';
    return row;
  }

  // ③ 抽出
  const ex = extractEvent_(mail);
  if (!ex.ok) {
    row.action = 'error';
    row.note = '抽出失敗: ' + ex.error;
    return row;
  }
  const ev = normalizeExtraction_(ex.data, mail.subject);
  if (!ev) {
    row.action = 'notify';
    row.reason = 'no_datetime';
    if (writes) notifyCalendar_(mail, null, '日時を抽出できなかった');
    return row;
  }
  row.ev = ev;
  row.note = [row.note, ev.note].filter(Boolean).join(' / ');
  if (ctx.stage < CAL_STAGE.MATCH) {
    row.action = 'extracted';
    return row;
  }

  // ④ 照合 → ⑤ 同一判定（0件なら Jev を呼ばない）
  const found = findNearbyEvents_(ev, matchCalendars_());
  row.existingCount = found.length;
  const matches = found.length ? judgeSameEvents_(found, ev, mail) : [];
  const decision = decideCalendarAction_(gate.reason, matches);
  row.reason = decision.reason;
  if (decision.index >= 0) {
    const m = matches[decision.index];
    row.matched = `${m.described.title} ${m.described.when}${found[decision.index].isProvisional ? '（仮登録）' : ''}`;
    row.relation = `${fmtChoice_(m.relation)} / same=${r2_(m.isSame)}`;
  } else if (matches.length) {
    row.matched = matches.map((m) => `${m.described.title}(${r2_(m.isSame)})`).join('; ');
  }

  // ⑥ 登録
  if (!writes) {
    row.action = 'would:' + decision.action;
    return row;
  }
  const done = applyCalendarAction_(decision, ev, mail, found, ctx.stage);
  row.action = done.action;
  if (done.note) row.note = [row.note, done.note].filter(Boolean).join(' / ');
  return row;
}

/** スレッドの中で判定する1通：自分以外が送った最新のメッセージ。 */
function pickMessage_(thread, me) {
  const msgs = thread.getMessages();
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (me.indexOf(emailOf_(msgs[i].getFrom())) < 0) return msgs[i];
  }
  return null;
}

function toMail_(msg, thread, domains) {
  const fullBody = msg.getPlainBody();
  return {
    id: msg.getId(),
    threadId: thread.getId(),
    subject: msg.getSubject(),
    from: msg.getFrom(),
    date: msg.getDate(),
    isExternal: isExternalSender_(msg.getFrom(), domains),
    isMailingList: isMailingList_(listHeaders_(msg), msg.getSubject()),
    toCount: (msg.getTo() + ',' + msg.getCc()).split(',').filter((s) => s.trim()).length,
    body: fullBody.slice(0, CONFIG.BODY_LIMIT),
    fullBody: fullBody,
  };
}

function listHeaders_(msg) {
  const h = (name) => {
    try {
      return msg.getHeader(name) || '';
    } catch (e) {
      return '';
    }
  };
  return { listId: h('List-Id'), listPost: h('List-Post'), precedence: h('Precedence') };
}

/** Jev に渡す state（既存スクリプトと同じ形）。社外判定と宛先人数はヘッダから分かるのでコード側で入れる */
function buildState_(mail) {
  return {
    subject: mail.subject,
    from: mail.from,
    is_external: mail.isExternal,
    to_count: mail.toCount,
    body: mail.body,
  };
}

function myAddresses_() {
  const list = [Session.getActiveUser().getEmail()].concat(GmailApp.getAliases());
  return list.filter(Boolean).map((s) => s.toLowerCase());
}

function emailOf_(from) {
  const m = String(from || '').match(/<([^>]+)>/);
  return (m ? m[1] : String(from || '')).trim().toLowerCase();
}

function ensureLabels_() {
  const out = {};
  Object.keys(CONFIG.LABELS).forEach((key) => {
    out[key] = label_(CONFIG.LABELS[key]);
  });
  return out;
}

function label_(name) {
  return GmailApp.getUserLabelByName(name) || GmailApp.createLabel(name);
}

function jstYmd_(date, sep) {
  const p = jstParts_(date);
  const s = sep || '-';
  return `${p.y}${s}${String(p.m).padStart(2, '0')}${s}${String(p.d).padStart(2, '0')}`;
}

// ===== 処理量の制御（既存スクリプトと同じ DAILY_COUNT を使う）=====

/** 今日あと何件処理できるか */
function remainingToday_() {
  const raw = prop_('DAILY_COUNT');
  const rec = raw ? JSON.parse(raw) : null;
  const today = jstYmd_(new Date());
  const used = rec && rec.date === today ? rec.count : 0;
  return Math.max(CONFIG.MAX_PER_DAY - used, 0);
}

function consumeToday_(n) {
  if (n <= 0) return;
  const raw = prop_('DAILY_COUNT');
  const rec = raw ? JSON.parse(raw) : null;
  const today = jstYmd_(new Date());
  const used = rec && rec.date === today ? rec.count : 0;
  setProp_('DAILY_COUNT', JSON.stringify({ date: today, count: used + n }));
}

/** 上限をリセットする。今日もう少しだけ回したいとき用 */
function resetDailyCount() {
  PropertiesService.getScriptProperties().deleteProperty('DAILY_COUNT');
  console.log('本日のカウントをリセットしました');
}

// ===== やり直し・移行 ============================================

/**
 * トリアージの判定をやり直す。_jev マーカーと重要度ラベルを外すので、
 * 次の実行で同じメールがもう一度評価される。質問文や重みを変えたあとに使う。
 */
function rerunAll() {
  const mark = GmailApp.getUserLabelByName(CONFIG.LABELS.PROCESSED);
  if (!mark) {
    console.log('マーカーラベルがありません');
    return;
  }
  const levels = [CONFIG.LABELS.HIGH, CONFIG.LABELS.MEDIUM]
    .map((n) => GmailApp.getUserLabelByName(n))
    .filter(Boolean);
  const threads = mark.getThreads(0, 200);
  threads.forEach((t) => {
    t.removeLabel(mark);
    levels.forEach((l) => t.removeLabel(l));
  });
  console.log(`${threads.length} 件の判定をリセットしました`);
}

/**
 * 旧バージョンのラベルを削除する。ラベルを消してもメール本体には影響しない。
 * 名前を変えたあとに一度だけ実行する。
 */
function cleanupOldLabels() {
  ['_jev済', '01_要即対応', '03_あとで'].forEach((name) => {
    const l = GmailApp.getUserLabelByName(name);
    if (l) {
      l.deleteLabel();
      console.log('削除: ' + name);
    }
  });
  console.log('完了。次に rerunAll() ではなく triageInbox() を実行してください。');
}
