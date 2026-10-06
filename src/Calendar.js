/**
 * ④ 照合（コード）と ⑥ 登録（コード）。
 *
 * 照合は CalendarApp.getEvents() を使うので、手入力の予定も他システムから入った予定も含まれる。
 * 本カレンダーと仮登録カレンダーの両方を見る。
 *
 * 書き込みの安全策:
 *   - 段階4では仮登録カレンダーにしか書かない。本カレンダーの予定は更新も中止印も付けない（通知のみ）
 *   - 中止連絡でも削除しない。件名に【中止】を付けて残す（削除は復旧できない）
 */

function mainCalendar_() {
  return CalendarApp.getDefaultCalendar();
}

function provisionalCalendar_(createIfMissing) {
  const name = CONFIG.CAL.PROVISIONAL_CALENDAR;
  const found = CalendarApp.getCalendarsByName(name);
  if (found.length) return found[0];
  if (!createIfMissing) return null;
  return CalendarApp.createCalendar(name, {
    summary: 'メールから自動登録した予定（検証用）。誤登録が多ければカレンダーごと削除してよい',
  });
}

/** 照合対象のカレンダー。[{calendar, isProvisional}] */
function matchCalendars_() {
  const list = [{ calendar: mainCalendar_(), isProvisional: false }];
  const prov = provisionalCalendar_(false);
  if (prov) list.push({ calendar: prov, isProvisional: true });
  return list;
}

/**
 * 抽出した日時の前後（既定3時間）にある既存予定を集める。
 * 変更連絡で変更前の日時が分かっていれば、その前後も見る。
 * @return {Array<{event: CalendarEvent, isProvisional: boolean}>}
 */
function findNearbyEvents_(ev, calendars) {
  const pad = CONFIG.CAL.MATCH_WINDOW_HOURS * 3600 * 1000;
  const windows = [];
  if (ev.allDay) {
    windows.push([ev.start.getTime() - pad, ev.end.getTime() + 86400000 + pad]);
  } else {
    windows.push([ev.start.getTime() - pad, ev.end.getTime() + pad]);
  }
  if (ev.previousStart) windows.push([ev.previousStart.getTime() - pad, ev.previousStart.getTime() + pad]);

  const seen = {};
  const out = [];
  calendars.forEach((c) => {
    windows.forEach((w) => {
      c.calendar.getEvents(new Date(w[0]), new Date(w[1])).forEach((e) => {
        const key = c.calendar.getId() + '|' + e.getId() + '|' + e.getStartTime().getTime();
        if (seen[key]) return;
        seen[key] = true;
        out.push({ event: e, isProvisional: c.isProvisional });
      });
    });
  });
  return out;
}

function describeEvent_(e) {
  const allDay = e.isAllDayEvent();
  const start = allDay ? e.getAllDayStartDate() : e.getStartTime();
  const end = allDay ? e.getAllDayEndDate() : e.getEndTime();
  return {
    title: e.getTitle(),
    when: allDay ? formatJst_(start, true) + ' 終日' : formatJst_(start, false) + ' 〜 ' + formatJst_(end, false),
    location: e.getLocation(),
    description: e.getDescription(),
  };
}

function describeExtracted_(ev, mailSubject) {
  return {
    title: ev.title,
    when: ev.allDay
      ? formatJst_(ev.start, true) + ' 終日'
      : formatJst_(ev.start, false) + ' 〜 ' + formatJst_(ev.end, false),
    location: ev.location,
    mailSubject: mailSubject,
  };
}

/**
 * ⑤ 既存予定1件ずつ同一判定する。stateに複数の予定を混ぜると判定がぼやける。
 * @return {Array<{isSame: ?number, relation: ?Object, described: Object, allDayCovers: boolean}>}
 */
function judgeSameEvents_(found, ev, mail) {
  const extracted = describeExtracted_(ev, mail.subject);
  return found.map((f) => {
    const described = describeEvent_(f.event);
    const a = jevAsk_(sameEventState_(described, extracted), sameEventQuestions_());
    return {
      isSame: a.is_same_event,
      relation: a.relation,
      described: described,
      allDayCovers: allDayCovers_(f.event, ev),
    };
  });
}

/** 既存が終日予定で、メールの時刻付き予定の開始がその期間に入っているか。 */
function allDayCovers_(e, ev) {
  if (ev.allDay || !e.isAllDayEvent()) return false;
  return allDayRangeCovers_(e.getAllDayStartDate(), e.getAllDayEndDate(), ev.start);
}

/** 終日予定の [開始日0時, 終了日0時) に t が入るか。終了日は翌日0時（排他的）。 */
function allDayRangeCovers_(startDay, endDay, t) {
  return startDay.getTime() <= t.getTime() && t.getTime() < endDay.getTime();
}

/**
 * ⑥ 決定した動作を実行する。
 * @return {{action: string, note: ?string}} 実際に行った動作（段階制限で通知に落ちた場合を含む）
 */
function applyCalendarAction_(decision, ev, mail, found, stage) {
  const target = decision.index >= 0 ? found[decision.index] : null;
  const writeCal =
    stage >= CAL_STAGE.MAIN ? mainCalendar_() : provisionalCalendar_(true);

  switch (decision.action) {
    case 'create': {
      const e = createEvent_(writeCal, ev, mail);
      return { action: 'create', note: stage >= CAL_STAGE.MAIN ? '本カレンダー' : '仮登録: ' + e.getId() };
    }
    case 'update':
    case 'mark_cancelled': {
      if (stage < CAL_STAGE.MAIN && !target.isProvisional) {
        notifyCalendar_(mail, ev, decision.action + '（本カレンダーの予定なので変更せず）');
        return { action: 'notify', note: '段階4では本カレンダーを変更しない' };
      }
      try {
        if (decision.action === 'update') updateEventTime_(target.event, ev, mail);
        else markCancelled_(target.event, mail);
        return { action: decision.action, note: null };
      } catch (e) {
        // 招待された予定など、自分が所有していない予定は変更できない
        notifyCalendar_(mail, ev, decision.action + ' に失敗: ' + e.message);
        return { action: 'notify', note: '変更失敗: ' + e.message };
      }
    }
    case 'notify':
      notifyCalendar_(mail, ev, decision.reason);
      return { action: 'notify', note: null };
    default:
      return { action: decision.action, note: null }; // none / skip
  }
}

function createEvent_(cal, ev, mail) {
  const options = { description: eventDescription_(ev, mail) };
  if (ev.location) options.location = ev.location;
  const e = ev.allDay
    ? cal.createAllDayEvent(ev.title, ev.start, new Date(ev.end.getTime() + 86400000), options)
    : cal.createEvent(ev.title, ev.start, ev.end, options);
  e.setTag('jev_message_id', mail.id);
  return e;
}

function updateEventTime_(e, ev, mail) {
  if (ev.allDay) e.setAllDayDates(ev.start, new Date(ev.end.getTime() + 86400000));
  else e.setTime(ev.start, ev.end);
  e.setDescription(
    (e.getDescription() || '') + `\n\n[Jev] ${formatJst_(new Date(), false)} 日時変更メールで更新: ${mailLink_(mail)}`
  );
}

function markCancelled_(e, mail) {
  const prefix = CONFIG.CAL.CANCEL_PREFIX;
  if (e.getTitle().indexOf(prefix) !== 0) e.setTitle(prefix + e.getTitle());
  e.setDescription((e.getDescription() || '') + `\n\n[Jev] 中止連絡: ${mailLink_(mail)}`);
}

function eventDescription_(ev, mail) {
  const lines = [];
  if (ev.onlineUrl) lines.push('オンライン: ' + ev.onlineUrl);
  if (ev.attendees.length) lines.push('参加者: ' + ev.attendees.join('、'));
  if (ev.note) lines.push('注記: ' + ev.note);
  lines.push('', '[Jev] メールから自動登録', '件名: ' + mail.subject, '差出人: ' + mail.from, mailLink_(mail));
  return lines.join('\n');
}

function mailLink_(mail) {
  return 'https://mail.google.com/mail/u/0/#all/' + mail.threadId;
}

/**
 * 登録も更新もしないときの通知。
 * スクリプトプロパティ NOTIFY_EMAIL があればそのアドレスへメールする。無ければログのみ。
 */
function notifyCalendar_(mail, ev, reason) {
  const when = ev ? describeExtracted_(ev, mail.subject).when : '(日時不明)';
  const body = [
    '予定の自動登録を見送りました。確認してください。',
    '',
    '理由: ' + reason,
    '件名: ' + mail.subject,
    '差出人: ' + mail.from,
    '抽出した日時: ' + when,
    mailLink_(mail),
  ].join('\n');
  console.log('[calendar notify] ' + body.replace(/\n/g, ' | '));
  const to = prop_('NOTIFY_EMAIL');
  if (to) GmailApp.sendEmail(to, '[Jev予定] 要確認: ' + mail.subject, body);
}
