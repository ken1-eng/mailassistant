/**
 * ③ 抽出（生成AI）。
 *
 * Jev は日付を順序ではなくテキストとして読むので、この層は生成AIでなければならない。
 * 「来週火曜14時から」をメールの受信日時を基準に実日時へ変換させる。
 * 抽出できない項目は推測させず null を返させる（埋めさせると誤登録の原因になる）。
 *
 * モデルはスクリプトプロパティ CLAUDE_MODEL で差し替えられる。
 */

const EXTRACT_DEFAULT_MODEL = 'claude-opus-5-5';

const EXTRACT_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: ['string', 'null'] },
    start: { type: ['string', 'null'] },
    end: { type: ['string', 'null'] },
    all_day: { type: ['boolean', 'null'] },
    location: { type: ['string', 'null'] },
    attendees: { type: ['array', 'null'], items: { type: 'string' } },
    online_url: { type: ['string', 'null'] },
    previous_start: { type: ['string', 'null'] },
    confidence_note: { type: ['string', 'null'] },
  },
  required: [
    'title',
    'start',
    'end',
    'all_day',
    'location',
    'attendees',
    'online_url',
    'previous_start',
    'confidence_note',
  ],
  additionalProperties: false,
};

const EXTRACT_SYSTEM_PROMPT = [
  'あなたはメールから予定を1件だけ取り出し、JSONで返す抽出器です。',
  '',
  '- 相対的な日付（「来週火曜」「明後日」「今月末」）は、与えられた「メール受信日時」を基準に実際の日付へ変換してください。',
  '- 日時は日本時間のISO 8601（例: 2026-10-05T14:00:00+09:00）で返してください。終日の予定は日付のみ（例: 2026-10-05）にし、all_day を true にしてください。',
  '- メールに書かれていない項目は推測せず null にしてください。特に終了時刻が書かれていなければ end は null です。',
  '- 変更連絡のときは、新しい日時を start / end に、変更前の日時が書かれていれば previous_start に入れてください。',
  '- title はカレンダーの件名として短く（30字程度）。相手の会社名や会議の種類が分かるようにしてください。',
  '- 仮定や曖昧な点があれば confidence_note に日本語で短く書いてください。無ければ null。',
  '- 予定が複数あるときは、このメールが主に案内している1件を選び、その旨を confidence_note に書いてください。',
  '- 出力はJSONオブジェクトのみ。前置きやMarkdownのコードブロックは付けないでください。',
].join('\n');

/**
 * @param {{subject: string, from: string, body: string, date: Date}} mail
 * @return {{ok: boolean, data: ?Object, error: ?string}}
 */
function extractEvent_(mail) {
  const key = prop_('ANTHROPIC_API_KEY');
  if (!key) return { ok: false, data: null, error: 'ANTHROPIC_API_KEY が未設定' };

  const payload = {
    model: prop_('CLAUDE_MODEL', EXTRACT_DEFAULT_MODEL),
    max_tokens: 4096,
    system: EXTRACT_SYSTEM_PROMPT,
    output_config: {
      effort: 'low',
      format: { type: 'json_schema', schema: EXTRACT_SCHEMA },
    },
    fallbacks: 'default',
    messages: [{ role: 'user', content: extractUserContent_(mail) }],
  };

  const res = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
    method: 'post',
    contentType: 'application/json',
    headers: {
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'server-side-fallback-2026-07-01',
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  });

  const code = res.getResponseCode();
  if (code !== 200) {
    return { ok: false, data: null, error: `Claude ${code}: ${res.getContentText().slice(0, 300)}` };
  }
  return parseExtractResponse_(JSON.parse(res.getContentText()));
}

function extractUserContent_(mail) {
  return [
    'メール受信日時: ' + formatJstWithWeekday_(mail.date),
    '差出人: ' + mail.from,
    '件名: ' + mail.subject,
    '',
    '本文:',
    mail.body,
  ].join('\n');
}

/** Messages API のレスポンスから抽出結果を取り出す。パースは必ず try-catch で囲む。 */
function parseExtractResponse_(response) {
  if (!response) return { ok: false, data: null, error: 'empty response' };
  if (response.stop_reason === 'refusal') return { ok: false, data: null, error: 'refusal' };
  if (response.stop_reason === 'max_tokens') return { ok: false, data: null, error: 'max_tokens' };

  const block = (response.content || []).find((b) => b.type === 'text');
  if (!block) return { ok: false, data: null, error: 'no text block' };

  let text = String(block.text).trim();
  // 構造化出力で来るはずだが、念のため前置きやコードブロックを剥がす
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) text = fenced[1];
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first < 0 || last < first) return { ok: false, data: null, error: 'no json' };

  try {
    return { ok: true, data: JSON.parse(text.slice(first, last + 1)), error: null };
  } catch (e) {
    return { ok: false, data: null, error: 'json parse: ' + e.message };
  }
}

/**
 * 抽出結果をカレンダー登録できる形に整える。
 * 終了時刻が無ければ開始の1時間後とし、仮定したことを note に残す。
 * @return {?{title, start: Date, end: Date, allDay: boolean, location, attendees, onlineUrl, previousStart: ?Date, note}}
 */
function normalizeExtraction_(ex, mailSubject) {
  if (!ex || !ex.start) return null;
  const notes = ex.confidence_note ? [ex.confidence_note] : [];
  const allDay = ex.all_day === true || /^\d{4}-\d{2}-\d{2}$/.test(ex.start);

  let start;
  let end;
  if (allDay) {
    start = parseJstDate_(ex.start.slice(0, 10));
    end = ex.end ? parseJstDate_(String(ex.end).slice(0, 10)) : null;
    if (!start) return null;
    if (!end || end < start) end = start;
    // 終日予定の end は「最終日」を表す（Calendar 側で翌日0時にする）
  } else {
    start = parseIsoDate_(ex.start);
    if (!start) return null;
    end = ex.end ? parseIsoDate_(ex.end) : null;
    if (!end || end <= start) {
      if (ex.end) notes.push('終了時刻が不正なため既定の長さにした');
      else if (!ex.confidence_note || !/終了/.test(ex.confidence_note)) notes.push('終了時刻の記載なし。1時間と仮定');
      end = new Date(start.getTime() + CONFIG.CAL.DEFAULT_DURATION_MIN * 60 * 1000);
    }
  }

  return {
    title: ex.title || mailSubject || '(件名なし)',
    start: start,
    end: end,
    allDay: allDay,
    location: ex.location || null,
    attendees: Array.isArray(ex.attendees) ? ex.attendees : [],
    onlineUrl: ex.online_url || null,
    previousStart: ex.previous_start ? parseIsoDate_(ex.previous_start) || parseJstDate_(ex.previous_start) : null,
    note: notes.join(' / ') || null,
  };
}

/** タイムゾーン付き ISO。タイムゾーンが無ければ日本時間とみなす。 */
function parseIsoDate_(s) {
  if (!s) return null;
  const str = String(s).trim();
  const m = str.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?(Z|[+\-]\d{2}:?\d{2})?$/);
  if (!m) return null;
  const tz = m[7] || '+09:00';
  const d = new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6] || '00'}${tz.length === 5 ? tz.slice(0, 3) + ':' + tz.slice(3) : tz}`);
  return isNaN(d.getTime()) ? null : d;
}

/** YYYY-MM-DD を日本時間のその日0時として返す。 */
function parseJstDate_(s) {
  const m = String(s || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  if (dayNumberOf_(Number(m[1]), Number(m[2]), Number(m[3])) === null) return null;
  return new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00+09:00`);
}

function formatJstWithWeekday_(date) {
  const t = new Date(date.getTime() + CONFIG.TZ_OFFSET_HOURS * 3600 * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  const wd = '日月火水木金土'[t.getUTCDay()];
  return (
    `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}` +
    `T${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}:00+09:00（${wd}曜日）`
  );
}

function formatJst_(date, allDay) {
  const s = formatJstWithWeekday_(date);
  return allDay ? s.slice(0, 10) + s.slice(-5) : s.slice(0, 16).replace('T', ' ') + s.slice(-5);
}
