/**
 * エントリポイント。
 *
 *   setup()       初回に1回。開始日・ラベル・ログシート・5分トリガーを用意する
 *   triageInbox() トリガーから呼ばれる本処理
 *   dryRun()      手動実行用。ラベルもマーカーも付けず、カレンダーにも書かず、採点と記録だけ行う
 *   teardown()    トリガーを外す
 *
 * 1通のメールにつき Jev へのリクエストは1回（① トリアージ8問＋② 予定判定3問をまとめる）。
 * 質問を何問詰めても待ち時間はほぼ変わらないので、質問は惜しまない。
 */

function setup() {
  if (!prop_('START_DATE')) setProp_('START_DATE', jstYmd_(new Date()));
  [CONFIG.TRIAGE.LABEL_HIGH, CONFIG.TRIAGE.LABEL_MID, CONFIG.TRIAGE.MARKER, CONFIG.CAL.MARKER].forEach(label_);
  const ss = logSpreadsheet_(true);
  logSheet_(CONFIG.LOG.TRIAGE_SHEET, TRIAGE_LOG_HEADERS);
  logSheet_(CONFIG.LOG.CAL_SHEET, CAL_LOG_HEADERS);
  if (calStage_() >= CAL_STAGE.PROVISIONAL) provisionalCalendar_(true);

  teardown();
  ScriptApp.newTrigger('triageInbox').timeBased().everyMinutes(CONFIG.TRIGGER_MINUTES).create();

  console.log(
    `setup 完了: 開始日=${prop_('START_DATE')} 段階=${calStage_()} ログ=${ss.getUrl()}` +
      '（ラベルの色は Gmail の画面で手動で付ける）'
  );
}

function teardown() {
  ScriptApp.getProjectTriggers()
    .filter((t) => t.getHandlerFunction() === 'triageInbox')
    .forEach((t) => ScriptApp.deleteTrigger(t));
}

function triageInbox() {
  run_(false);
}

function dryRun() {
  run_(true);
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
  const startDate = prop_('START_DATE');
  if (!startDate && !dry) throw new Error('START_DATE が未設定。setup() を先に実行する');
  const after = startDate || jstYmd_(new Date(Date.now() - 3 * 86400000));

  const limit = Math.min(CONFIG.LIMITS.PER_RUN, dry ? CONFIG.LIMITS.PER_RUN : dailyRemaining_());
  if (limit <= 0) {
    console.log(`1日あたり上限（${CONFIG.LIMITS.PER_RUN}件/回, ${CONFIG.LIMITS.PER_DAY}件/日）に達したので終了`);
    return;
  }

  const targets = findTargets_(after, stage, dry, limit);
  const ctx = { dry: dry, stage: stage, me: myAddresses_(), domains: internalDomains_() };

  for (let i = 0; i < targets.length; i++) {
    if (Date.now() - startedAt > CONFIG.LIMITS.RUN_TIME_BUDGET_MS) {
      console.log('実行時間の上限に近づいたので残りは次回');
      break;
    }
    try {
      processThread_(targets[i], ctx);
    } catch (e) {
      // マーカーを付けずに残すので次回また拾う。日次上限にはカウントするので暴走はしない
      console.error(`処理失敗 thread=${targets[i].thread.getId()}: ${e.stack || e}`);
    }
    if (!dry) countDaily_();
  }
}

/**
 * 処理対象のスレッドを集める。
 * トリアージは未読が対象（既存スクリプトと同じ）。
 * 予定判定は既読でも対象にする（予定の見落としを避ける。二重処理は _cal マーカーで防ぐ）。
 */
function findTargets_(after, stage, dry, limit) {
  const base = `after:${after.replace(/-/g, '/')} -in:chats -in:drafts`;
  const needCal = stage >= CAL_STAGE.JUDGE;
  const map = {};
  const add = (threads, key) =>
    threads.forEach((t) => {
      const id = t.getId();
      if (!map[id]) map[id] = { thread: t, needTriage: false, needCal: false };
      map[id][key] = true;
    });

  if (dry) {
    add(GmailApp.search(`${base} is:unread`, 0, limit), 'needTriage');
    if (needCal) add(GmailApp.search(base, 0, limit), 'needCal');
  } else {
    add(GmailApp.search(`${base} is:unread -label:${CONFIG.TRIAGE.MARKER}`, 0, limit), 'needTriage');
    if (needCal) add(GmailApp.search(`${base} -label:${CONFIG.CAL.MARKER}`, 0, limit), 'needCal');
  }
  return Object.keys(map)
    .map((k) => map[k])
    .slice(0, limit);
}

function processThread_(target, ctx) {
  const thread = target.thread;
  const msg = pickMessage_(thread, ctx.me);
  if (!msg) {
    // 自分が送ったメールだけのスレッドなど。判定対象がないので処理済みにする
    if (!ctx.dry) markDone_(thread, target);
    return;
  }

  const mail = toMail_(msg, thread);
  const questions = []
    .concat(target.needTriage ? TRIAGE_QUESTIONS : [])
    .concat(target.needCal ? SCHEDULE_QUESTIONS : []);
  const answers = jevAsk_(mailState_(mail), questions);
  const mode = ctx.dry ? 'dry-run' : '本番';

  if (target.needTriage) {
    const r = triageOne_(mail, answers, ctx);
    if (!ctx.dry) {
      if (r.label) thread.addLabel(label_(r.label));
      if (r.label === CONFIG.TRIAGE.LABEL_HIGH) notifyUrgent_(mail, r.score);
    }
    logTriage_(mode, mail, answers, r);
  }

  if (target.needCal) {
    const row = calendarOne_(mail, answers, ctx);
    logCalendar_(mode, mail, answers, row);
  }

  if (!ctx.dry) markDone_(thread, target);
}

function markDone_(thread, target) {
  if (target.needTriage) thread.addLabel(label_(CONFIG.TRIAGE.MARKER));
  if (target.needCal) thread.addLabel(label_(CONFIG.CAL.MARKER));
}

function triageOne_(mail, a, ctx) {
  const deadlineDays = daysUntilDeadline_(mail.subject + '\n' + mail.body, new Date());
  const isExternal = isExternalSender_(mail.from, ctx.domains);
  const score = scoreTriage_(a, { deadlineDays: deadlineDays, isExternal: isExternal });
  return { score: score, label: triageLabelFor_(score), deadlineDays: deadlineDays, isExternal: isExternal };
}

/**
 * ②〜⑥。段階（CAL_STAGE）より先には進まない。dry-run と段階3以下では何も書き込まない。
 */
function calendarOne_(mail, a, ctx) {
  const row = { ev: null, existingCount: null, matched: null, relation: null, action: '', reason: '', note: '' };
  const writes = !ctx.dry && ctx.stage >= CAL_STAGE.PROVISIONAL;

  // ② 予定を含むか
  const gate = scheduleGate_(a);
  row.reason = gate.reason;
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
  row.note = ev.note || '';
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
    row.relation = `${fmtChoice_(m.relation)} / same=${fmtNum_(m.isSame)}`;
  } else if (matches.length) {
    row.matched = matches.map((m) => `${m.described.title}(${fmtNum_(m.isSame)})`).join('; ');
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
    const addr = emailOf_(msgs[i].getFrom());
    if (me.indexOf(addr) < 0) return msgs[i];
  }
  return null;
}

function toMail_(msg, thread) {
  const recipients = (msg.getTo() + ',' + msg.getCc()).split(',').filter((s) => /@/.test(s));
  return {
    id: msg.getId(),
    threadId: thread.getId(),
    subject: msg.getSubject(),
    from: msg.getFrom(),
    date: msg.getDate(),
    body: msg.getPlainBody().slice(0, CONFIG.LIMITS.BODY_CHARS),
    recipientCount: recipients.length,
  };
}

/** Jev に渡す state。社外判定・宛先人数・日付の計算はコード側でやるので入れない。 */
function mailState_(mail) {
  return ['件名: ' + mail.subject, '差出人: ' + mail.from, '', mail.body].join('\n');
}

function myAddresses_() {
  const list = [Session.getActiveUser().getEmail()].concat(GmailApp.getAliases());
  return list.filter(Boolean).map((s) => s.toLowerCase());
}

function emailOf_(from) {
  const m = String(from || '').match(/<([^>]+)>/);
  return (m ? m[1] : String(from || '')).trim().toLowerCase();
}

function label_(name) {
  return GmailApp.getUserLabelByName(name) || GmailApp.createLabel(name);
}

function jstYmd_(date) {
  const p = jstParts_(date);
  return `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
}

/** 1日あたり上限。日付（日本時間）が変わるとリセット。 */
function dailyKey_() {
  return 'DAILY_COUNT_' + jstYmd_(new Date());
}

function dailyRemaining_() {
  return CONFIG.LIMITS.PER_DAY - Number(prop_(dailyKey_(), '0'));
}

function countDaily_() {
  const props = PropertiesService.getScriptProperties();
  const key = dailyKey_();
  const n = Number(props.getProperty(key) || '0') + 1;
  props.setProperty(key, String(n));
  if (n === 1) {
    // 前日以前のカウンタを掃除
    Object.keys(props.getProperties())
      .filter((k) => k.indexOf('DAILY_COUNT_') === 0 && k !== key)
      .forEach((k) => props.deleteProperty(k));
  }
}
