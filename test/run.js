/**
 * 本機測試 (Node.js ≥ 16，無外部套件)
 *
 *   node test/run.js
 *
 * 把 Code.gs 載入到一個帶有 Apps Script 服務 stub 的沙盒，
 * 只測「純函式」層：郵件解析、分類、商家正規化、報表統計。
 * 需要真實 Sheets / Gmail 的函式 (doPost、抓信、渲染) 不在此測。
 */
var fs = require("fs");
var path = require("path");
var vm = require("vm");
var assert = require("assert");

// ---------- Apps Script 服務 stub ----------
var scriptProps = {};
var fakeSheets = {};   // name -> { rows: [[...], ...] }

function makeSheet(name) {
  var s = fakeSheets[name];
  if (!s) return null;
  return {
    getName: function () { return name; },
    getLastRow: function () { return s.rows.length; },
    getRange: function (r, c, nr, nc) {
      return {
        getValues: function () {
          var out = [];
          for (var i = 0; i < nr; i++) {
            var row = s.rows[r - 1 + i] || [];
            var slice = [];
            for (var j = 0; j < nc; j++) slice.push(row[c - 1 + j] === undefined ? "" : row[c - 1 + j]);
            out.push(slice);
          }
          return out;
        }
      };
    }
  };
}

var sandbox = {
  console: console,
  PropertiesService: {
    getScriptProperties: function () {
      return {
        getProperty: function (k) { return scriptProps[k] === undefined ? null : scriptProps[k]; },
        setProperty: function (k, v) { scriptProps[k] = v; }
      };
    }
  },
  SpreadsheetApp: {
    getActiveSpreadsheet: function () {
      return { getSheetByName: function (n) { return makeSheet(n); } };
    }
  },
  GmailApp: {}, LockService: {}, ContentService: {}, Utilities: {}, Session: {}
};
vm.createContext(sandbox);
var code = fs.readFileSync(path.join(__dirname, "..", "Code.gs"), "utf8");
vm.runInContext(code, sandbox, { filename: "Code.gs" });

var passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log("  ✓ " + name); }
  catch (e) { failed++; console.log("  ✗ " + name + "\n      " + (e.message || e)); }
}
function resetRuleCache() { sandbox._compiledRules = null; }
// vm 沙盒內建立的物件 prototype 與外層不同，deepStrictEqual 會誤判，改比 JSON
function same(actual, expected, msg) { assert.strictEqual(JSON.stringify(actual), JSON.stringify(expected), msg); }

// ---------- 1. 郵件解析 ----------
console.log("\nparseCathayEmail_V2");
test("multi-word merchant is not truncated", function () {
  var body = [
    "國泰世華 消費彙整通知",
    "交易日期 2026/09/01",
    "NT$ 1,234 SQ *ALAMO SQUARE CAFE   ",
    "NT$85 統一超商 台北忠孝門市",
    "2026/9/2",
    "NT$ 2,000 藏壽司 信義店"
  ].join("\n");
  var r = sandbox.parseCathayEmail_V2(body);
  assert.strictEqual(r.length, 3);
  same(r[0], { date: "2026/09/01", amount: 1234, merchant: "SQ *ALAMO SQUARE CAFE" });
  same(r[1], { date: "2026/09/01", amount: 85, merchant: "統一超商 台北忠孝門市" });
  same(r[2], { date: "2026/9/2", amount: 2000, merchant: "藏壽司 信義店" });
});
test("amount lines before any date are ignored", function () {
  var r = sandbox.parseCathayEmail_V2("NT$ 100 早到的商家\n2026/01/01\nNT$ 50 正常商家");
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].merchant, "正常商家");
});
test("empty body → no transactions", function () {
  same(sandbox.parseCathayEmail_V2(""), []);
});

// ---------- 2. 正規化 + 分類 ----------
console.log("\nnormalizeText / determineCategory");
test("full-width → half-width, quotes stripped", function () {
  assert.strictEqual(sandbox.normalizeText("ＩＫＥＡ　Ｔ`ＷＡＹ"), "IKEA TWAY");
});
test("keyword match is case-insensitive and width-insensitive", function () {
  resetRuleCache();
  assert.strictEqual(sandbox.determineCategory("ＩＫＥＡ 新莊店"), "🛍️ 生活購物");
  assert.strictEqual(sandbox.determineCategory("t`way air"), "✈️ 旅遊出行");
  assert.strictEqual(sandbox.determineCategory("SQ *ALAMO SQUARE CAFE"), "🍔 餐飲美食");
});
test("unknown merchant → default category", function () {
  resetRuleCache();
  assert.strictEqual(sandbox.determineCategory("XYZ 某某未知商家"), sandbox.CONFIG.DEFAULT_CATEGORY);
  assert.strictEqual(sandbox.determineCategory(""), sandbox.CONFIG.DEFAULT_CATEGORY);
  assert.strictEqual(sandbox.determineCategory(null), sandbox.CONFIG.DEFAULT_CATEGORY);
});
test("removed keyword 'EAT' no longer misfires on GREAT / THEATER", function () {
  resetRuleCache();
  assert.strictEqual(sandbox.determineCategory("GREAT WALL SUPPLY"), sandbox.CONFIG.DEFAULT_CATEGORY);
});
test("override sheet takes precedence over CONFIG keywords", function () {
  fakeSheets[sandbox.CONFIG.OVERRIDE_SHEET_NAME] = {
    rows: [
      ["商家關鍵字", "分類", "備註"],
      ["ｓｑ *alamo", "📺 數位娛樂", "測試：全形+小寫也要命中"],
      ["", "🏥 醫療保健", "空關鍵字要被忽略"],
      ["某某牙醫", "🏥 醫療保健", ""]
    ]
  };
  resetRuleCache();
  assert.strictEqual(sandbox.determineCategory("SQ *ALAMO SQUARE CAFE"), "📺 數位娛樂");
  assert.strictEqual(sandbox.determineCategory("某某牙醫診所"), "🏥 醫療保健");
  assert.strictEqual(sandbox.determineCategory("藏壽司"), "🍔 餐飲美食"); // 未覆寫者不受影響
  delete fakeSheets[sandbox.CONFIG.OVERRIDE_SHEET_NAME];
  resetRuleCache();
  assert.strictEqual(sandbox.determineCategory("SQ *ALAMO SQUARE CAFE"), "🍔 餐飲美食");
});
test("compiled rules are cached within one execution", function () {
  resetRuleCache();
  var a = sandbox.getCompiledRules_();
  var b = sandbox.getCompiledRules_();
  assert.strictEqual(a, b);
  assert.ok(a.length > 100, "expected >100 compiled keywords, got " + a.length);
});

// ---------- 3. 商家正規化 (Pareto 用) ----------
console.log("\ncanonicalMerchant");
test("chain-store branches collapse to one name", function () {
  assert.strictEqual(sandbox.canonicalMerchant("統一超商 台北忠孝門市"), "統一超商");
  assert.strictEqual(sandbox.canonicalMerchant("OP錢包統一超商"), "統一超商");
  assert.strictEqual(sandbox.canonicalMerchant("全家便利商店 板橋店"), "全家便利商店");
  assert.strictEqual(sandbox.canonicalMerchant("SQ *ALAMO SQUARE CAFE"), "(美國) Square 商家");
  assert.strictEqual(sandbox.canonicalMerchant("decathlon taipei"), "DECATHLON 迪卡儂");
});
test("unknown merchant passes through normalized", function () {
  assert.strictEqual(sandbox.canonicalMerchant("ＡＢＣ 商店"), "ABC 商店");
});

// ---------- 4. 已處理郵件 ID 上限 ----------
console.log("\nprocessed msgId ring buffer");
test("stays under the 9KB PropertiesService value limit", function () {
  var ids = [];
  for (var i = 0; i < 2000; i++) sandbox.rememberProcessedId_(ids, "1" + String(i).padStart(15, "a"));
  assert.strictEqual(ids.length, sandbox.CONFIG.MAX_PROCESSED_IDS);
  var bytes = Buffer.byteLength(JSON.stringify(ids), "utf8");
  assert.ok(bytes < 9 * 1024, "serialized size " + bytes + " bytes exceeds 9KB");
});
test("token is read from Script Properties first", function () {
  scriptProps.API_TOKEN = "  from-props  ";
  assert.strictEqual(sandbox.getApiToken_(), "from-props");
  delete scriptProps.API_TOKEN;
  assert.strictEqual(sandbox.getApiToken_(), sandbox.CONFIG.API_TOKEN || "");
});

// ---------- 5. 報表統計 ----------
console.log("\ncalculateStatsForYear / buildYearReport");
function rowsFor(year, spec) {
  // spec: [[month, amount, merchant, category, income], ...]
  return [["日期", "支出", "收入", "內容", "分類", "來源"]].concat(spec.map(function (s) {
    return [new Date(year, s[0] - 1, 15), s[1], s[4] || "", s[2], s[3], "test"];
  }));
}
test("matrix, MoM, YoY, KPI, Pareto and income are computed correctly", function () {
  fakeSheets["2025"] = { rows: rowsFor(2025, [[1, 1000, "A", "X"], [2, 2000, "B", "X"]]) };
  fakeSheets["2026"] = { rows: rowsFor(2026, [
    [1, 1100, "統一超商 甲店", "X"],
    [1, 400, "統一超商 乙店", "X"],
    [2, 3000, "藏壽司", "Y"],
    [3, 0, "薪水", "💰 個人收入", 50000]
  ]) };
  var stats = sandbox.calculateStatsForYear(makeSheet("2026"), makeSheet("2025"));
  same(stats.categories, ["X", "Y"]);
  assert.strictEqual(stats.matrix.X[1], 1500);
  assert.strictEqual(stats.countMatrix.X[1], 2);
  assert.strictEqual(stats.merchantTotals["統一超商"], 1500, "branches merged for Pareto");
  assert.strictEqual(stats.totalIncome, 50000);
  assert.strictEqual(stats.prevYearMonthly[1], 1000);

  var rep = sandbox.buildYearReport(stats);
  var main = rep.mainTable;
  assert.strictEqual(main[0][13], "🔥 總計");
  assert.strictEqual(main[1][13], 1500);            // X 年度總計
  assert.strictEqual(main[3][13], 4500);            // 每月總計列的年總計
  assert.strictEqual(main[4][2], "+100.0%");        // MoM 2月: (3000-1500)/1500
  assert.strictEqual(main[5][1], "+50.0%");         // YoY 1月: (1500-1000)/1000
  assert.strictEqual(main[5][2], "+50.0%");         // YoY 2月: (3000-2000)/2000
  assert.strictEqual(rep.kpiTable[1][1], 2);        // X 筆數
  assert.strictEqual(rep.kpiTable[1][3], 750);      // X 平均單筆
  assert.strictEqual(rep.paretoTable[1][1], 2);     // 商家總數 (合併後)
  assert.strictEqual(rep.paretoTable[6][1], "藏壽司");
  same(rep.incomeTable[3], ["年度淨額", 50000 - 4500]);
  same(rep.anomalies, [], "too few months → no anomaly flags");
  delete fakeSheets["2025"]; delete fakeSheets["2026"];
});
test("anomaly flag fires only with ≥ ANOMALY_MIN_MONTHS and beyond mean+2σ", function () {
  var spec = [];
  for (var m = 1; m <= 7; m++) spec.push([m, 1000, "A", "X"]);
  spec.push([8, 20000, "A", "X"]);
  fakeSheets["2026"] = { rows: rowsFor(2026, spec) };
  var rep = sandbox.buildYearReport(sandbox.calculateStatsForYear(makeSheet("2026"), null));
  same(rep.anomalies, [{ rowOffset: 1, colOffset: 9 }]); // 8月 = 第 9 欄
  delete fakeSheets["2026"];
});
test("empty year sheet → null stats", function () {
  fakeSheets["2024"] = { rows: [["日期", "支出", "收入", "內容", "分類", "來源"]] };
  assert.strictEqual(sandbox.calculateStatsForYear(makeSheet("2024"), null), null);
  delete fakeSheets["2024"];
});

console.log("\n" + passed + " passed, " + failed + " failed\n");
process.exit(failed ? 1 : 0);
