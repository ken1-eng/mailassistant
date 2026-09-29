// src/*.js を1つの Code.gs にまとめる（Apps Script のエディタに1回で貼れるように）。
// 読み込み時に他ファイルの定数を参照しない書き方なので、単純な連結でよい。
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const order = ['Config', 'Jev', 'Triage', 'Schedule', 'Extract', 'Calendar', 'Log', 'Main'];
const all = fs.readdirSync(path.join(root, 'src')).filter((f) => f.endsWith('.js')).map((f) => f.slice(0, -3));
const missing = all.filter((f) => order.indexOf(f) < 0);
if (missing.length) throw new Error('build.js の order に無いファイル: ' + missing.join(', '));

const header = [
  '/**',
  ' * Gmail × Jev メールトリアージ ＋ メール→カレンダー自動登録（1ファイル版）',
  ' *',
  ' * このファイルは scripts/build.js が src/*.js から生成したもの。直接編集しない。',
  ' * 貼り付け方：Apps Script エディタで既存のコードを全部消して、これを1ファイルに貼る。',
  ' * appsscript.json は触らなくてよい（権限は Apps Script がコードから自動で判定する）。',
  ' */',
  '',
].join('\n');

const body = order
  .map((name) => {
    const src = fs.readFileSync(path.join(root, 'src', name + '.js'), 'utf8').trimEnd();
    return `// ===== ${name}.js ${'='.repeat(Math.max(0, 60 - name.length))}\n\n${src}\n`;
  })
  .join('\n\n');

fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
fs.writeFileSync(path.join(root, 'dist', 'Code.gs'), header + body);
console.log('dist/Code.gs を生成しました');
