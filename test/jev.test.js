const test = require('node:test');
const assert = require('node:assert/strict');
const { loadGas } = require('./load');

const g = loadGas();

test('定義済みの質問はすべて書式チェックを通る（422 の予防）', () => {
  g.buildJevPayload_('state', g.TRIAGE_QUESTIONS);
  g.buildJevPayload_('state', g.SCHEDULE_QUESTIONS);
  g.buildJevPayload_('state', g.sameEventQuestions_());
});

test('Score の criteria がオブジェクトだと弾く', () => {
  assert.throws(
    () => g.buildJevPayload_('s', [{ name: 'u', type: 'score', question: 'q', criteria: { a: 'x', b: 'y' } }]),
    /Score/
  );
});

test('Choice の criteria が配列だと弾く', () => {
  assert.throws(
    () => g.buildJevPayload_('s', [{ name: 'c', type: 'choice', question: 'q', criteria: ['a', 'b'] }]),
    /Choice/
  );
});

test('parseJevAnswers_: 型ごとに正規化し、欠けた回答は null', () => {
  const qs = [
    { name: 'n', type: 'noul', question: 'q' },
    { name: 's', type: 'score', question: 'q', criteria: ['a', 'b'] },
    { name: 'c', type: 'choice', question: 'q', criteria: { a: 'x', b: 'y' } },
    { name: 'missing', type: 'noul', question: 'q' },
  ];
  const r = g.parseJevAnswers_(
    {
      answers: {
        n: { noul: 0.83 },
        s: { score: 2.4, confidence: 0.7 },
        c: { choice: 'b', confidence: 0.9, probabilities: { a: 0.1, b: 0.9 } },
      },
    },
    qs
  );
  assert.equal(r.n, 0.83);
  assert.equal(r.s.score, 2.4);
  assert.equal(r.s.confidence, 0.7);
  assert.equal(r.c.choice, 'b');
  assert.equal(r.missing, null);
});
