// Apps Script のソースを Node の vm に読み込む。GAS のサービスは呼ばない純粋関数だけをテストする。
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadGas() {
  const dir = path.join(__dirname, '..', 'src');
  const code = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.js'))
    .sort()
    .map((f) => fs.readFileSync(path.join(dir, f), 'utf8'))
    .join('\n');
  const ctx = vm.createContext({ console });
  vm.runInContext(code + '\nthis.CONFIG = CONFIG; this.CAL_STAGE = CAL_STAGE; this.TRIAGE_QUESTIONS = TRIAGE_QUESTIONS; this.SCHEDULE_QUESTIONS = SCHEDULE_QUESTIONS;', ctx);
  return ctx;
}

module.exports = { loadGas };
