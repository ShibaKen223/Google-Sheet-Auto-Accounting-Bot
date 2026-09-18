/**
 * 全自動記帳系統 V4.2 (安全性 + 效能 + 可維護性修正版)
 *
 * 🆕 V4.2 更新 (架構不變，直接整份貼回 Apps Script 編輯器即可):
 *  1. 🔐 API token 改存 Script Properties → 原始碼可安心公開；CONFIG 內不再放密鑰
 *  2. 🐛 修正 PROCESSED_MSG_IDS 超過 9KB 上限 → 保留 500 筆會撞到 PropertiesService 單值上限而寫入失敗，改為 300 筆
 *  3. ⚡ 分類關鍵字預先正規化並快取       → 重新分類數千筆交易不再每筆重算 ~200 個關鍵字
 *  4. 📖 新增「分類覆寫」工作表           → 在表格裡直接指定「商家包含 X → 分類 Y」，不用改程式碼
 *  5. 🧪 新增 Node 測試 (test/run.js)     → 純函式 (解析 / 分類 / 統計) 可在本機驗證
 *  6. 🛡️ doPost 金額驗證                  → 金額為空或 0 直接回覆錯誤，不再寫入空白列
 *
 * ⚠️ V4.2 貼回後必做:
 *  a. Apps Script 編輯器 → 專案設定 → 指令碼屬性 → 新增 API_TOKEN = 你的長隨機字串
 *     (舊版寫在 CONFIG.API_TOKEN 的值請換新，因為它曾經出現在原始碼中)
 *  b. (選用) 選單「📖 建立分類覆寫表」→ 在表格裡加規則 → 跑「♻️ 重新分類所有交易」
 *
 * ── V4.1 更新紀錄 ──
 *  1. 🔐 doPost 加 token 驗證          → 防止 Web App URL 外洩被亂寫
 *  2. 🔒 LockService                    → 郵件觸發與 iOS 捷徑同時執行不再互踩
 *  3. ♻️ 郵件冪等處理                   → 記錄已處理 msgId，中斷重跑不會重複記帳
 *  4. 🏷️ 解析失敗改標已讀+上標籤        → 不再永遠卡在未讀重掃；標籤「記帳/解析失敗」
 *  5. ✂️ 商家名稱不再被截斷             → regex 改抓整行 (SQ *ALAMO SQUARE CAFE 不會變 SQ)
 *  6. 📚 分類字典大擴充                → 貼回後跑一次「♻️ 重新分類所有交易」，
 *                                         未分類可從 25% 壓到 5% 以下 (已實測)
 *  7. 🏪 Pareto 商家正規化              → 統一超商各分店合併計算，集中度不再失真
 *  8. ⚡ 批次寫入 + doPost 預設不重建戰情室 → iOS 捷徑秒回；戰情室改由觸發器/選單刷新
 *  9. 📉 異常偵測改樣本標準差 (n-1)、至少 6 個月才啟動 → 減少假警報
 * 10. 💵 戰情室新增「年度收支」小區塊 (收入/支出/淨額)
 *
 * ⚠️ 貼回後必做:
 *  a. CONFIG.API_TOKEN 改成你自己的長隨機字串，iOS 捷徑的 JSON 加上 "token" 欄位
 *  b. 執行選單「♻️ 重新分類所有交易」套用新字典
 *  c. 建議把 updateUnifiedWarRoom 設成每小時的時間觸發器
 *  d. 字典移除了過短易誤傷的關鍵字 "EAT" (會命中 GREAT/THEATER/SEATTLE)
 */

// ==========================================
// ⚙️ 設定區
// ==========================================
var CONFIG = {
  WAR_ROOM_SHEET_NAME: "📊 總戰情室",
  EMAIL_QUERY: 'from:cathaybk.com.tw subject:"消費彙整通知" is:unread',

  // 🔐 V4.2: token 改存 Script Properties (鍵名 API_TOKEN)，這裡留空即可。
  //    只有在 Script Properties 沒設定時才會退回用這個值 (不建議)。
  API_TOKEN: "",

  // 📱 doPost 寫入後是否立即重建戰情室 (false = 秒回，交給觸發器刷新)
  REFRESH_ON_POST: false,

  // 🏷️ 解析失敗郵件的標籤
  FAIL_LABEL: "記帳/解析失敗",

  // ♻️ 已處理郵件 ID 保留筆數。PropertiesService 單一值上限 9KB，
  //    每個 Gmail msgId 約 19 bytes (含 JSON 引號逗號)，300 筆 ≈ 5.7KB 留有餘裕。
  MAX_PROCESSED_IDS: 300,

  // 📖 V4.2: 分類覆寫工作表 (A 欄=商家關鍵字, B 欄=分類)，比 CATEGORIES 優先
  OVERRIDE_SHEET_NAME: "📖 分類覆寫",

  // 異常偵測閾值 (樣本標準差倍數) 與最少月份數
  ANOMALY_SIGMA: 2,
  ANOMALY_MIN_MONTHS: 6,

  // Pareto 分析
  PARETO_TOP_PCT: 0.20,
  PARETO_TOP_N: 5,

  // keyword 比對前會先「全形→半形 + 移除引號 + toUpperCase」正規化
  CATEGORIES: {
    "🍔 餐飲美食": ["餐飲", "星巴克", "麥當勞", "路易莎", "餐廳", "FOOD", "咖啡", "食品", "小吃", "早餐", "午餐", "晚餐", "雞肉飯", "BAKERY", "統一超商", "7-ELEVEN", "全家", "FamilyMart", "全聯", "超市", "量販", "家樂福", "美廉社", "OP錢包", "日常支出", "SAFEWAY", "OK超商", "涮乃葉", "藏壽司", "六本木", "台鋼漢堡王", "漢堡", "食堂", "鍋物", "壽司", "燒肉", "拉麵", "CAFE"],
    "🛍️ 生活購物": ["一般購物", "蝦皮", "MOMO", "PCHOME", "百貨", "UNIQLO", "IKEA", "服飾", "休閒用品", "GlobalMall", "家電", "TAOBAO", "Newbalance", "燦坤", "陳守", "全國電子", "原價屋", "ZARA", "ABC-MART", "迪卡儂", "DECATHLON", "寶雅", "剪頭髮", "美髮", "美容"],
    "⛽ 交通出行": ["交通", "運輸", "臺灣鐵路", "臺鐵", "高鐵", "捷運", "悠遊卡", "中油", "台塑", "加油", "停車", "UBER", "TAXI", "微笑單車", "監理所", "車麗屋"],
    "✈️ 旅遊出行": ["HOTEL", "飯店", "住宿", "旅行社", "Booking", "BKG", "STARLUX", "星宇", "華航", "長榮航", "TWAY", "Airbnb", "Agoda", "民宿", "LONDON", "KLOOK", "Golden Gate", "旅遊", "賓館", "ESTA", "LAWSON", "JOOSIK", "EXIMBAY", "HITOMEBORE", "MAMESHIBA", "BITSUKUKAMERA"],
    "📺 數位娛樂": ["NETFLIX", "SPOTIFY", "YOUTUBE", "APPLE", "GOOGLE", "STEAM", "CLIPPER", "娛樂", "威秀", "影城", "CLAUDE.AI", "ANTHROPIC", "OPENAI"],
    "🏥 醫療保健": ["醫院", "診所", "藥局", "屈臣氏", "康是美", "醫療救護"],
    "🛡️ 保險": ["保險", "富邦產物", "國泰人壽", "新光人壽", "國壽保費", "旅平險"],
    "🎓 教育學習": ["學費", "註冊費", "教育", "學雜費", "TUITION", "臺灣銀行", "台灣銀行", "書局", "誠品", "金石堂", "電腦技能基金會", "Kobo", "博客來", "LEADERSHIP"],
    "🏦 提款轉帳": ["提款", "轉帳", "CASH", "全支付"],
    "🏠 房屋雜費": ["房租", "水費", "電費", "瓦斯", "管理費", "中華電信", "家具家飾", "開鎖", "輕鬆繳"],
    "🪙 投資支出": ["定期定額", "Alchemy", "alchemypay", "AlchemyPay", "MAX交易所", "BitoPro", "幣安", "Binance", "加密"],
    "💰 個人收入": ["生活費", "獎助學金", "薪水", "薪資", "零用金", "家教", "收入"]
  },
  DEFAULT_CATEGORY: "其他支出",

  // 🏪 連鎖商家正規化 (Pareto 集中度分析用；[regex, 正規化名稱])
  MERCHANT_ALIASES: [
    [/統一超商|OP錢包統一/, "統一超商"],
    [/全家便利商店|^全家/, "全家便利商店"],
    [/^OK超商/, "OK超商"],
    [/^萊爾富/, "萊爾富"],
    [/^NET/, "NET"],
    [/寶雅/, "寶雅"],
    [/藏壽司/, "藏壽司"],
    [/全國電子/, "全國電子"],
    [/迪卡儂|DECATHLON/i, "DECATHLON 迪卡儂"],
    [/CLAUDE\.AI|ANTHROPIC/i, "Anthropic Claude"],
    [/^SQ \*/, "(美國) Square 商家"],
    [/^TST\*/, "(美國) Toast 商家"]
  ]
};

// ==========================================
// 📱 iOS API (捷徑)
// ==========================================
function doPost(e) {
  var merchant = "未知項目";
  var finalAmount = "0";
  var category = "未知分類";

  try {
    var data = {};
    try {
      data = JSON.parse(e.postData.contents);
    } catch (parseErr) {
      return ContentService.createTextOutput("資料格式解析失敗");
    }

    // 🔐 V4.2: token 從 Script Properties 讀取；未設定或不符一律拒絕
    var expectedToken = getApiToken_();
    if (!expectedToken || data.token !== expectedToken) {
      return ContentService.createTextOutput("⛔ 未授權");
    }

    var date = data.date ? new Date(data.date) : new Date();
    if (isNaN(date.getTime())) date = new Date();
    var year = date.getFullYear().toString();

    var rawAmount = (data.amount || "").toString();
    var expenseVal = "";
    var incomeVal = "";
    var cleanAmount = parseFloat(rawAmount.replace(/[^0-9.]/g, ""));

    // 🛡️ V4.2: 金額無效就不寫入，避免產生空白列
    if (!(cleanAmount > 0)) {
      return ContentService.createTextOutput("⚠️ 金額無效: " + rawAmount);
    }
    if (rawAmount.indexOf("+") > -1) incomeVal = cleanAmount;
    else expenseVal = cleanAmount;

    var inputType = data.type || "";
    merchant = data.note || data.type || "手動輸入";
    if (CONFIG.CATEGORIES[inputType]) {
      category = inputType;
    } else {
      category = determineCategory(inputType || merchant);
    }
    finalAmount = (incomeVal !== "") ? incomeVal : expenseVal;

    // 🔒 V4.1: 上鎖寫入，避免與郵件觸發器互踩
    var lock = LockService.getScriptLock();
    lock.waitLock(30000);
    try {
      var sheet = getOrCreateSheet(year);
      writeRowsToSheet(sheet, [[date, expenseVal, incomeVal, merchant, category, '📱 iOS捷徑']]);
      if (CONFIG.REFRESH_ON_POST) updateUnifiedWarRoom();
    } finally {
      lock.releaseLock();
    }

    return ContentService.createTextOutput("✅ 記帳成功!\n" +
      "💰 金額:$" + finalAmount + "\n" +
      "📝 項目:" + merchant + "\n" +
      "📂 分類:" + category
    );

  } catch (criticalErr) {
    return ContentService.createTextOutput("⚠️ 寫入失敗\n" + criticalErr.toString());
  }
}

// ==========================================
// 📩 自動抓取信用卡彙整郵件
// ==========================================
function processConsolidatedEmails() {
  var threads = GmailApp.search(CONFIG.EMAIL_QUERY);
  if (threads.length === 0) return;
  processThreadsBatch(threads, false);
}

function processThreadsBatch(threads, isTestMode) {
  var hasNewData = false;
  var processedIds = getProcessedIds_();
  var failLabel = null;

  // 🔒 V4.1: 整批處理上鎖
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    threads.forEach(function (thread) {
      var messages = thread.getMessages();
      messages.forEach(function (msg) {
        if (!isTestMode && !msg.isUnread()) return;

        // ♻️ V4.1: 冪等 — 處理過的信直接跳過 (即使上次中斷時沒來得及標已讀)
        var msgId = msg.getId();
        if (!isTestMode && processedIds.indexOf(msgId) > -1) {
          msg.markRead();
          return;
        }

        var body = msg.getPlainBody();
        var transactions = parseCathayEmail_V2(body);

        if (transactions.length > 0) {
          hasNewData = true;

          // ⚡ V4.1: 按年份分組後批次寫入 (原本逐筆 insertRow 很吃配額)
          var byYear = {};
          transactions.forEach(function (tx) {
            var date = new Date(tx.date);
            var year = date.getFullYear().toString();
            if (!byYear[year]) byYear[year] = [];
            byYear[year].push([date, tx.amount, "", tx.merchant, determineCategory(tx.merchant), '📧 國泰信箱']);
          });
          Object.keys(byYear).forEach(function (year) {
            // 新到舊排序，寫入後最上面是最新一筆
            byYear[year].sort(function (a, b) { return b[0] - a[0]; });
            writeRowsToSheet(getOrCreateSheet(year), byYear[year]);
          });

          if (!isTestMode) {
            msg.markRead();
            rememberProcessedId_(processedIds, msgId);
          }
        } else if (!isTestMode) {
          // 🏷️ V4.1: 解析失敗 → 標已讀 + 上標籤，不再每次重掃
          msg.markRead();
          if (!failLabel) {
            failLabel = GmailApp.getUserLabelByName(CONFIG.FAIL_LABEL) ||
                        GmailApp.createLabel(CONFIG.FAIL_LABEL);
          }
          failLabel.addToThread(thread);
        }
      });
    });

    saveProcessedIds_(processedIds);
    if (hasNewData) {
      updateUnifiedWarRoom();
    }
  } finally {
    lock.releaseLock();
  }
}

// 🔐 V4.2: token 優先讀 Script Properties，退回 CONFIG (僅相容舊設定)
function getApiToken_() {
  var fromProps = PropertiesService.getScriptProperties().getProperty("API_TOKEN");
  return (fromProps && fromProps.trim()) || CONFIG.API_TOKEN || "";
}

// ♻️ V4.1: 已處理郵件 ID 存於 ScriptProperties
//    V4.2: 上限改由 CONFIG.MAX_PROCESSED_IDS 控制，避免超過 9KB 單值上限
function getProcessedIds_() {
  var raw = PropertiesService.getScriptProperties().getProperty("PROCESSED_MSG_IDS");
  try { return raw ? JSON.parse(raw) : []; } catch (e) { return []; }
}
function rememberProcessedId_(ids, id) {
  ids.push(id);
  while (ids.length > CONFIG.MAX_PROCESSED_IDS) ids.shift();
}
function saveProcessedIds_(ids) {
  PropertiesService.getScriptProperties().setProperty("PROCESSED_MSG_IDS", JSON.stringify(ids));
}

function parseCathayEmail_V2(body) {
  var lines = body.split('\n');
  var results = [];
  var tempDate = null;
  var dateRegex = /(\d{4}\/\d{1,2}\/\d{1,2})/;
  // ✂️ V4.1: 商家改抓「金額之後到行尾」，多字商家不再被截斷
  var amountLineRegex = /NT\$\s*([\d,]+)\s+(.+?)\s*$/;

  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].trim();
    if (line === "") continue;
    var dateMatch = line.match(dateRegex);
    if (dateMatch) {
      tempDate = dateMatch[1];
      continue;
    }
    if (tempDate) {
      var moneyMatch = line.match(amountLineRegex);
      if (moneyMatch) {
        results.push({
          date: tempDate,
          amount: parseFloat(moneyMatch[1].replace(/,/g, "")),
          merchant: moneyMatch[2]
        });
      }
    }
  }
  return results;
}

// ==========================================
// 🧠 寫入工作表 (共用，V4.1 改為批次)
// ==========================================
/** rows: [[Date物件, 支出, 收入, 內容, 分類, 來源], ...] 第一列會在最上面 */
function writeRowsToSheet(sheet, rows) {
  if (!rows || rows.length === 0) return;
  var n = rows.length;
  sheet.insertRowsAfter(1, n);
  var range = sheet.getRange(2, 1, n, 6);
  range.setValues(rows);
  range.setBackground(null).setFontWeight("normal").setFontColor("black");
  // V4.1: 直接寫 Date 物件 + 明確設日期格式，避免字串解析受時區/地區影響
  sheet.getRange(2, 1, n, 1).setNumberFormat("yyyy/MM/dd");
  sheet.getRange(2, 2, n, 2).setNumberFormat("NT$#,##0");
}

function getOrCreateSheet(sheetName) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(sheetName);

  if (!sheet) {
    sheet = ss.insertSheet(sheetName);
    sheet.appendRow(["日期", "支出", "收入", "內容", "分類", "來源"]);
    sheet.setFrozenRows(1);
    ss.setActiveSheet(sheet);
    ss.moveActiveSheet(2);
  }
  return sheet;
}

// ==========================================
// 👑 戰情室 Spend Analytics Dashboard
// ==========================================
function updateUnifiedWarRoom() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var warRoom = ss.getSheetByName(CONFIG.WAR_ROOM_SHEET_NAME);
  if (!warRoom) {
    warRoom = ss.insertSheet(CONFIG.WAR_ROOM_SHEET_NAME, 0);
  } else {
    warRoom.clear();
  }
  ss.setActiveSheet(warRoom);
  ss.moveActiveSheet(1);

  var yearSheets = ss.getSheets().filter(function (s) {
    return s.getName().match(/^\d{4}$/);
  });
  yearSheets.sort(function (a, b) {
    return Number(b.getName()) - Number(a.getName());
  });

  var querySheet = ss.getSheetByName("支出明細查詢");
  if (querySheet) {
    var yearsList = yearSheets.map(function (s) { return s.getName(); });
    if (yearsList.length > 0) {
      var rule = SpreadsheetApp.newDataValidation()
        .requireValueInList(yearsList, true)
        .setAllowInvalid(false)
        .build();
      querySheet.getRange("B1").setDataValidation(rule);
    }
  }

  var currentRow = 1;

  yearSheets.forEach(function (sourceSheet) {
    var year = sourceSheet.getName();
    var prevSheet = ss.getSheetByName((Number(year) - 1).toString());

    var stats = calculateStatsForYear(sourceSheet, prevSheet);
    if (!stats) return;

    var report = buildYearReport(stats);
    currentRow = renderYearReport(warRoom, currentRow, year, report);
  });

  warRoom.autoResizeColumns(1, 14);
}

// ==========================================
// 📊 統計引擎 (純資料,沒有副作用)
// ==========================================
function calculateStatsForYear(sheet, prevYearSheet) {
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return null;

  var data = sheet.getRange(2, 1, lastRow - 1, 6).getValues();

  var matrix = {};
  var countMatrix = {};
  var merchantTotals = {};
  var categories = {};
  var totalIncome = 0;   // 💵 V4.1
  var hasData = false;

  data.forEach(function (row) {
    var d = new Date(row[0]);
    var amt = Number(row[1]);
    var income = Number(row[2]);   // 💵 V4.1
    var note = (row[3] || "未知").toString();
    var cat = row[4] || CONFIG.DEFAULT_CATEGORY;

    if (!isNaN(income) && income > 0) totalIncome += income;
    if (isNaN(amt) || amt === 0) return;
    hasData = true;

    var month = d.getMonth() + 1;
    if (!matrix[cat]) { matrix[cat] = {}; countMatrix[cat] = {}; }
    matrix[cat][month] = (matrix[cat][month] || 0) + amt;
    countMatrix[cat][month] = (countMatrix[cat][month] || 0) + 1;

    // 🏪 V4.1: 商家正規化後再聚合 (Pareto 集中度才準)
    var canonical = canonicalMerchant(note);
    merchantTotals[canonical] = (merchantTotals[canonical] || 0) + amt;
    categories[cat] = true;
  });

  if (!hasData) return null;

  var prevYearMonthly = {};
  if (prevYearSheet && prevYearSheet.getLastRow() >= 2) {
    var prevData = prevYearSheet.getRange(2, 1, prevYearSheet.getLastRow() - 1, 6).getValues();
    prevData.forEach(function (row) {
      var d = new Date(row[0]);
      var amt = Number(row[1]);
      if (isNaN(amt) || amt === 0) return;
      var month = d.getMonth() + 1;
      prevYearMonthly[month] = (prevYearMonthly[month] || 0) + amt;
    });
  }

  return {
    matrix: matrix,
    countMatrix: countMatrix,
    merchantTotals: merchantTotals,
    categories: Object.keys(categories).sort(),
    prevYearMonthly: prevYearMonthly,
    totalIncome: totalIncome
  };
}

// ==========================================
// 🏗️ 報表建構
// ==========================================
function buildYearReport(stats) {
  // ---------- Section 1: 類別 × 月份 矩陣 ----------
  var headers = ["支出類別"];
  for (var m = 1; m <= 12; m++) headers.push(m + "月");
  headers.push("🔥 總計");

  var mainTable = [headers];
  var monthlyTotals = {};
  var yearlyGrandTotal = 0;
  var anomalies = [];

  stats.categories.forEach(function (cat, catIdx) {
    var row = [cat];
    var catTotal = 0;
    var monthValues = [];

    for (var m = 1; m <= 12; m++) {
      var val = (stats.matrix[cat] && stats.matrix[cat][m]) || 0;
      monthValues.push(val);
      row.push(val === 0 ? "-" : val);
      catTotal += val;
      monthlyTotals[m] = (monthlyTotals[m] || 0) + val;
    }

    // 🚨 V4.1: 樣本標準差 (n-1)、至少 ANOMALY_MIN_MONTHS 個月才啟動
    var nonZero = monthValues.filter(function (v) { return v > 0; });
    if (nonZero.length >= CONFIG.ANOMALY_MIN_MONTHS) {
      var mean = nonZero.reduce(function (a, b) { return a + b; }, 0) / nonZero.length;
      var variance = nonZero.reduce(function (a, b) { return a + Math.pow(b - mean, 2); }, 0) / (nonZero.length - 1);
      var std = Math.sqrt(variance);
      if (std > 0) {
        var threshold = mean + CONFIG.ANOMALY_SIGMA * std;
        for (var i = 0; i < 12; i++) {
          if (monthValues[i] > threshold) {
            anomalies.push({ rowOffset: catIdx + 1, colOffset: i + 2 });
          }
        }
      }
    }

    row.push(catTotal);
    mainTable.push(row);
    yearlyGrandTotal += catTotal;
  });

  var totalRow = ["💰 每月總計"];
  for (var m = 1; m <= 12; m++) {
    var v = monthlyTotals[m] || 0;
    totalRow.push(v === 0 ? "-" : v);
  }
  totalRow.push(yearlyGrandTotal);
  mainTable.push(totalRow);

  var momRow = ["📊 MoM 變化"];
  for (var m = 1; m <= 12; m++) {
    var prev = monthlyTotals[m - 1] || 0;
    var curr = monthlyTotals[m] || 0;
    if (m === 1 || prev === 0 || curr === 0) {
      momRow.push("-");
    } else {
      var pct = ((curr - prev) / prev) * 100;
      momRow.push((pct >= 0 ? "+" : "") + pct.toFixed(1) + "%");
    }
  }
  momRow.push("-");
  mainTable.push(momRow);

  var hasPrev = Object.keys(stats.prevYearMonthly).length > 0;
  if (hasPrev) {
    var yoyRow = ["🎯 YoY 變化"];
    for (var m = 1; m <= 12; m++) {
      var prev = stats.prevYearMonthly[m] || 0;
      var curr = monthlyTotals[m] || 0;
      if (prev === 0 || curr === 0) {
        yoyRow.push("-");
      } else {
        var pct = ((curr - prev) / prev) * 100;
        yoyRow.push((pct >= 0 ? "+" : "") + pct.toFixed(1) + "%");
      }
    }
    yoyRow.push("-");
    mainTable.push(yoyRow);
  }

  // ---------- Section 2: 類別 KPI ----------
  var kpiTable = [["類別", "筆數", "總額", "平均單筆", "占比"]];
  stats.categories.forEach(function (cat) {
    var total = 0, count = 0;
    for (var m = 1; m <= 12; m++) {
      total += (stats.matrix[cat] && stats.matrix[cat][m]) || 0;
      count += (stats.countMatrix[cat] && stats.countMatrix[cat][m]) || 0;
    }
    var avg = count > 0 ? Math.round(total / count) : 0;
    var pct = yearlyGrandTotal > 0 ? (total / yearlyGrandTotal) * 100 : 0;
    kpiTable.push([cat, count, total, avg, pct.toFixed(1) + "%"]);
  });

  // ---------- Section 3: Pareto / 供應商集中度 ----------
  var sortedMerchants = Object.keys(stats.merchantTotals).map(function (name) {
    return [name, stats.merchantTotals[name]];
  }).sort(function (a, b) { return b[1] - a[1]; });

  var totalSpend = sortedMerchants.reduce(function (a, b) { return a + b[1]; }, 0);
  var top20Count = Math.max(1, Math.ceil(sortedMerchants.length * CONFIG.PARETO_TOP_PCT));
  var top20Spend = sortedMerchants.slice(0, top20Count).reduce(function (a, b) { return a + b[1]; }, 0);
  var top20Pct = totalSpend > 0 ? (top20Spend / totalSpend) * 100 : 0;

  var paretoTable = [
    ["指標", "數值", "比例"],
    ["全年商家總數", sortedMerchants.length, "100%"],
    ["Top 20% 商家數", top20Count, ((top20Count / Math.max(1, sortedMerchants.length)) * 100).toFixed(0) + "%"],
    ["Top 20% 貢獻支出", top20Spend, top20Pct.toFixed(1) + "%"],
    ["", "", ""],
    ["排名", "商家", "支出"]
  ];
  var topN = Math.min(CONFIG.PARETO_TOP_N, sortedMerchants.length);
  for (var i = 0; i < topN; i++) {
    paretoTable.push(["#" + (i + 1), sortedMerchants[i][0], sortedMerchants[i][1]]);
  }

  // ---------- Section 4: 年度收支 (💵 V4.1) ----------
  var incomeTable = [
    ["💵 年度收支", "金額"],
    ["年度收入", stats.totalIncome],
    ["年度支出", yearlyGrandTotal],
    ["年度淨額", stats.totalIncome - yearlyGrandTotal]
  ];

  return {
    mainTable: mainTable,
    anomalies: anomalies,
    kpiTable: kpiTable,
    paretoTable: paretoTable,
    incomeTable: incomeTable,
    numCategories: stats.categories.length,
    hasYoY: hasPrev
  };
}

// ==========================================
// 🎨 報表渲染 (寫入 + 排版)
// ==========================================
function renderYearReport(warRoom, startRow, year, report) {
  var currentRow = startRow;
  var moneyFmt = "NT$#,##0;-NT$#,##0;\"-\"";

  warRoom.getRange(currentRow, 1).setValue("📅 " + year + " 年度報表")
    .setFontSize(14).setFontWeight("bold").setFontColor("#1155cc");
  currentRow++;

  // ---------- Section 1: 主矩陣 ----------
  warRoom.getRange(currentRow, 1).setValue("📊 類別 × 月份 支出矩陣 (Spend Matrix)")
    .setFontWeight("bold").setFontColor("#666666");
  currentRow++;

  var mainRows = report.mainTable.length;
  var mainCols = report.mainTable[0].length;
  warRoom.getRange(currentRow, 1, mainRows, mainCols).setValues(report.mainTable);

  warRoom.getRange(currentRow, 1, 1, mainCols).setBackground("#f3f3f3").setFontWeight("bold");

  var dataStartRow = currentRow + 1;
  if (report.numCategories > 0) {
    warRoom.getRange(dataStartRow, 2, report.numCategories, mainCols - 1).setNumberFormat(moneyFmt);
  }

  report.anomalies.forEach(function (a) {
    warRoom.getRange(dataStartRow + a.rowOffset - 1, a.colOffset)
      .setBackground("#fce5cd").setFontColor("#990000").setFontWeight("bold");
  });

  var totalRowIdx = dataStartRow + report.numCategories;
  warRoom.getRange(totalRowIdx, 1, 1, mainCols).setBackground("#fff2cc").setFontWeight("bold");
  warRoom.getRange(totalRowIdx, 2, 1, mainCols - 1).setNumberFormat(moneyFmt);

  warRoom.getRange(totalRowIdx + 1, 1, 1, mainCols).setBackground("#e6f0ff").setFontStyle("italic");
  if (report.hasYoY) {
    warRoom.getRange(totalRowIdx + 2, 1, 1, mainCols).setBackground("#d9ead3").setFontStyle("italic");
  }

  currentRow += mainRows + 1;

  // ---------- Section 2: 類別 KPI ----------
  warRoom.getRange(currentRow, 1).setValue("📈 類別深度分析 (Category KPIs)")
    .setFontWeight("bold").setFontColor("#666666");
  currentRow++;

  var kpiRows = report.kpiTable.length;
  var kpiCols = report.kpiTable[0].length;
  warRoom.getRange(currentRow, 1, kpiRows, kpiCols).setValues(report.kpiTable);
  warRoom.getRange(currentRow, 1, 1, kpiCols).setBackground("#f3f3f3").setFontWeight("bold");
  if (kpiRows > 1) {
    warRoom.getRange(currentRow + 1, 3, kpiRows - 1, 2).setNumberFormat(moneyFmt);
    // 🔢 V4.1: 筆數明確設為整數格式 (清掉可能殘留的貨幣格式)
    warRoom.getRange(currentRow + 1, 2, kpiRows - 1, 1).setNumberFormat("0");
  }

  currentRow += kpiRows + 1;

  // ---------- Section 3: Pareto / 供應商集中度 ----------
  warRoom.getRange(currentRow, 1).setValue("🎯 供應商集中度分析 (Pareto 80-20，連鎖商家已合併)")
    .setFontWeight("bold").setFontColor("#666666");
  currentRow++;

  var paretoRows = report.paretoTable.length;
  var paretoCols = 3;
  warRoom.getRange(currentRow, 1, paretoRows, paretoCols).setValues(report.paretoTable);
  warRoom.getRange(currentRow, 1, 1, paretoCols).setBackground("#f3f3f3").setFontWeight("bold");
  // 🔢 V4.1: 商家總數 / Top20% 商家數是「個數」，明確設整數格式
  warRoom.getRange(currentRow + 1, 2, 2, 1).setNumberFormat("0");
  warRoom.getRange(currentRow + 3, 2).setNumberFormat(moneyFmt);
  var topListCount = paretoRows - 6;
  if (topListCount > 0) {
    warRoom.getRange(currentRow + 5, 1, 1, paretoCols).setBackground("#f3f3f3").setFontWeight("bold");
    warRoom.getRange(currentRow + 6, 3, topListCount, 1).setNumberFormat(moneyFmt);
  }

  currentRow += paretoRows + 1;

  // ---------- Section 4: 年度收支 (💵 V4.1) ----------
  var incRows = report.incomeTable.length;
  warRoom.getRange(currentRow, 1, incRows, 2).setValues(report.incomeTable);
  warRoom.getRange(currentRow, 1, 1, 2).setBackground("#f3f3f3").setFontWeight("bold");
  warRoom.getRange(currentRow + 1, 2, incRows - 1, 1).setNumberFormat(moneyFmt);

  currentRow += incRows + 2;
  return currentRow;
}

// ==========================================
// 🔍 輔助函式
// ==========================================
function normalizeText(str) {
  if (!str) return "";
  return str
    .replace(/[！-～]/g, function (ch) {
      return String.fromCharCode(ch.charCodeAt(0) - 0xFEE0);
    })
    .replace(/　/g, ' ')
    .replace(/[`'‘’"“”]/g, '');
}

// ⚡ V4.2: 關鍵字只正規化一次 (每次執行快取)，重新分類幾千筆時省下大量重複運算
var _compiledRules = null;
function getCompiledRules_() {
  if (_compiledRules) return _compiledRules;
  var rules = [];

  // 1) 📖 覆寫表優先 (存在才讀；沒有這張表時行為與 V4.1 完全相同)
  getOverrideRules_().forEach(function (r) { rules.push(r); });

  // 2) CONFIG.CATEGORIES 依宣告順序，第一個命中的類別勝出
  for (var cat in CONFIG.CATEGORIES) {
    var keywords = CONFIG.CATEGORIES[cat];
    for (var i = 0; i < keywords.length; i++) {
      var kw = normalizeText(keywords[i]).toUpperCase();
      if (kw) rules.push({ keyword: kw, category: cat });
    }
  }
  _compiledRules = rules;
  return rules;
}

// 📖 V4.2: 讀取「分類覆寫」表 (A 欄=商家關鍵字, B 欄=分類，第 1 列為標題)
function getOverrideRules_() {
  var rules = [];
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss && ss.getSheetByName(CONFIG.OVERRIDE_SHEET_NAME);
    if (!sheet || sheet.getLastRow() < 2) return rules;
    var values = sheet.getRange(2, 1, sheet.getLastRow() - 1, 2).getValues();
    values.forEach(function (row) {
      var kw = normalizeText((row[0] || "").toString().trim()).toUpperCase();
      var cat = (row[1] || "").toString().trim();
      if (kw && cat) rules.push({ keyword: kw, category: cat });
    });
  } catch (e) {
    // doPost / 觸發器情境下若無法讀表，安靜退回關鍵字規則
  }
  return rules;
}

function determineCategory(merchantName) {
  var normalized = normalizeText(merchantName || "").toUpperCase();
  if (!normalized) return CONFIG.DEFAULT_CATEGORY;
  var rules = getCompiledRules_();
  for (var i = 0; i < rules.length; i++) {
    if (normalized.indexOf(rules[i].keyword) > -1) return rules[i].category;
  }
  return CONFIG.DEFAULT_CATEGORY;
}

// 📖 V4.2: 建立覆寫表 (已存在就只切換過去)
function createOverrideSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(CONFIG.OVERRIDE_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(CONFIG.OVERRIDE_SHEET_NAME);
    sheet.getRange(1, 1, 1, 3).setValues([["商家關鍵字 (包含即命中)", "分類", "備註"]])
      .setBackground("#f3f3f3").setFontWeight("bold");
    sheet.getRange(2, 1, 1, 3).setValues([["範例: 某某牙醫", "🏥 醫療保健", "刪掉這列後開始填自己的規則"]])
      .setFontColor("#888888").setFontStyle("italic");
    sheet.setFrozenRows(1);
    var cats = Object.keys(CONFIG.CATEGORIES).concat([CONFIG.DEFAULT_CATEGORY]);
    var rule = SpreadsheetApp.newDataValidation()
      .requireValueInList(cats, true).setAllowInvalid(false).build();
    sheet.getRange(2, 2, 500, 1).setDataValidation(rule);
    sheet.autoResizeColumns(1, 3);
  }
  ss.setActiveSheet(sheet);
}

// 🏪 V4.1: 連鎖商家正規化 (只給 Pareto 聚合用，不動原始資料)
function canonicalMerchant(name) {
  var n = normalizeText(name);
  for (var i = 0; i < CONFIG.MERCHANT_ALIASES.length; i++) {
    if (CONFIG.MERCHANT_ALIASES[i][0].test(n)) return CONFIG.MERCHANT_ALIASES[i][1];
  }
  return n;
}

// ==========================================
// 🔍 Tail Spend 診斷 (analyzeUnclassified)
// ==========================================
function analyzeUnclassified() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var DIAG_SHEET_NAME = "🔍 待分類診斷";

  var yearSheets = ss.getSheets().filter(function (s) {
    return s.getName().match(/^\d{4}$/);
  });
  yearSheets.sort(function (a, b) {
    return Number(b.getName()) - Number(a.getName());
  });

  if (yearSheets.length === 0) {
    SpreadsheetApp.getUi().alert("還沒有任何年度工作表可以分析。");
    return;
  }

  var merchantTotals = {};
  var grandTotalAllYears = 0;
  var unclassifiedTotalAllYears = 0;
  var perYearStats = {};

  yearSheets.forEach(function (sheet) {
    var year = sheet.getName();
    var lastRow = sheet.getLastRow();
    if (lastRow < 2) return;

    var data = sheet.getRange(2, 1, lastRow - 1, 6).getValues();
    perYearStats[year] = { total: 0, unclassified: 0 };

    data.forEach(function (row) {
      var date = row[0];
      var amt = Number(row[1]);
      var note = (row[3] || "未知").toString().trim();
      var cat = row[4] || CONFIG.DEFAULT_CATEGORY;

      if (isNaN(amt) || amt === 0) return;

      perYearStats[year].total += amt;
      grandTotalAllYears += amt;

      if (cat !== CONFIG.DEFAULT_CATEGORY) return;

      perYearStats[year].unclassified += amt;
      unclassifiedTotalAllYears += amt;

      if (!merchantTotals[note]) {
        merchantTotals[note] = { count: 0, total: 0, years: {}, lastDate: null };
      }
      merchantTotals[note].count += 1;
      merchantTotals[note].total += amt;
      merchantTotals[note].years[year] = true;
      var dateObj = (date instanceof Date) ? date : new Date(date);
      if (!merchantTotals[note].lastDate || dateObj > merchantTotals[note].lastDate) {
        merchantTotals[note].lastDate = dateObj;
      }
    });
  });

  var sorted = Object.keys(merchantTotals).map(function (name) {
    return {
      name: name,
      count: merchantTotals[name].count,
      total: merchantTotals[name].total,
      years: Object.keys(merchantTotals[name].years).sort().join(", "),
      lastDate: merchantTotals[name].lastDate,
      pctOfUnclassified: unclassifiedTotalAllYears > 0
        ? (merchantTotals[name].total / unclassifiedTotalAllYears) * 100 : 0
    };
  }).sort(function (a, b) { return b.total - a.total; });

  var diag = ss.getSheetByName(DIAG_SHEET_NAME);
  if (!diag) {
    diag = ss.insertSheet(DIAG_SHEET_NAME);
  } else {
    diag.clear();
    diag.clearConditionalFormatRules();
  }

  var moneyFmt = "NT$#,##0";
  var row = 1;

  diag.getRange(row, 1).setValue("🔍 Tail Spend 診斷報告 (Unclassified Spend Analysis)")
    .setFontSize(14).setFontWeight("bold").setFontColor("#cc0000");
  row += 2;

  diag.getRange(row, 1).setValue("📊 各年度未分類占比")
    .setFontWeight("bold").setFontColor("#666666");
  row++;

  var summaryHeaders = ["年度", "總支出", "未分類支出", "未分類占比", "健康度"];
  diag.getRange(row, 1, 1, 5).setValues([summaryHeaders])
    .setBackground("#f3f3f3").setFontWeight("bold");
  row++;

  Object.keys(perYearStats).sort(function (a, b) { return Number(b) - Number(a); })
    .forEach(function (year) {
      var s = perYearStats[year];
      var pct = s.total > 0 ? (s.unclassified / s.total) * 100 : 0;
      var health;
      if (pct < 5) health = "🟢 優秀 (<5%)";
      else if (pct < 10) health = "🟡 可接受 (5-10%)";
      else if (pct < 20) health = "🟠 需改善 (10-20%)";
      else health = "🔴 嚴重 (>20%)";

      diag.getRange(row, 1, 1, 5).setValues([[
        year, s.total, s.unclassified, pct.toFixed(1) + "%", health
      ]]);
      diag.getRange(row, 2, 1, 2).setNumberFormat(moneyFmt);
      row++;
    });

  var grandPct = grandTotalAllYears > 0
    ? (unclassifiedTotalAllYears / grandTotalAllYears) * 100 : 0;
  diag.getRange(row, 1, 1, 5).setValues([[
    "📈 全期間合計", grandTotalAllYears, unclassifiedTotalAllYears,
    grandPct.toFixed(1) + "%", ""
  ]]).setBackground("#fff2cc").setFontWeight("bold");
  diag.getRange(row, 2, 1, 2).setNumberFormat(moneyFmt);
  row += 2;

  if (sorted.length === 0) {
    diag.getRange(row, 1).setValue("✅ 沒有任何「其他支出」分類,完美!")
      .setFontWeight("bold").setFontColor("#0c8a4e");
  } else {
    diag.getRange(row, 1).setValue("🏆 未分類商家排行榜 (Top 30)")
      .setFontWeight("bold").setFontColor("#666666");
    row++;
    diag.getRange(row, 1).setValue("👉 把這裡的高頻商家加進「📖 分類覆寫」表或 CONFIG.CATEGORIES,再跑「♻️ 重新分類」即可大幅降低未分類比例")
      .setFontStyle("italic").setFontColor("#888888");
    row++;

    var headers = ["排名", "商家名稱", "出現年份", "筆數", "累計支出", "占未分類比例", "最後出現"];
    diag.getRange(row, 1, 1, headers.length).setValues([headers])
      .setBackground("#f3f3f3").setFontWeight("bold");
    row++;

    var topN = Math.min(30, sorted.length);
    var rowsToWrite = [];
    for (var i = 0; i < topN; i++) {
      var m = sorted[i];
      rowsToWrite.push([
        "#" + (i + 1),
        m.name,
        m.years,
        m.count,
        m.total,
        m.pctOfUnclassified.toFixed(1) + "%",
        m.lastDate ? Utilities.formatDate(m.lastDate, Session.getScriptTimeZone(), "yyyy/MM/dd") : "-"
      ]);
    }
    diag.getRange(row, 1, topN, headers.length).setValues(rowsToWrite);
    diag.getRange(row, 5, topN, 1).setNumberFormat(moneyFmt);
    // 🔢 V4.1: 筆數欄設整數格式
    diag.getRange(row, 4, topN, 1).setNumberFormat("0");

    var cumPct = 0;
    for (var i = 0; i < topN; i++) {
      cumPct += sorted[i].pctOfUnclassified;
      if (cumPct >= 80) {
        diag.getRange(row + i, 1, 1, headers.length)
          .setBorder(null, null, true, null, null, null,
            "#ff0000", SpreadsheetApp.BorderStyle.DASHED);
        diag.getRange(row + i, headers.length + 1)
          .setValue("← 累計 80% 在這條線以上")
          .setFontColor("#cc0000").setFontStyle("italic");
        break;
      }
    }
    row += topN;
  }

  diag.autoResizeColumns(1, 8);
  ss.setActiveSheet(diag);

  SpreadsheetApp.getUi().alert(
    "✅ 診斷完成!\n\n" +
    "全期間未分類占比:" + grandPct.toFixed(1) + "%\n" +
    "未分類商家數:" + sorted.length + "\n\n" +
    "請查看「🔍 待分類診斷」工作表,把高頻商家加進「📖 分類覆寫」表或 CONFIG.CATEGORIES。"
  );
}

// ==========================================
// ♻️ 重新分類所有交易 (reclassifyAllRows)
// ==========================================
function reclassifyAllRows() {
  var ui = SpreadsheetApp.getUi();
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  var yearSheets = ss.getSheets().filter(function (s) {
    return s.getName().match(/^\d{4}$/);
  });

  if (yearSheets.length === 0) {
    ui.alert("沒有找到任何年度工作表。");
    return;
  }

  // ----- Step 1: Dry-run -----
  var totalRows = 0;
  var changedCount = 0;
  var fromOtherCount = 0;
  var betweenCatsCount = 0;
  var sampleChanges = [];

  yearSheets.forEach(function (sheet) {
    var lastRow = sheet.getLastRow();
    if (lastRow < 2) return;
    var data = sheet.getRange(2, 1, lastRow - 1, 6).getValues();

    data.forEach(function (row) {
      var merchant = (row[3] || "").toString();
      var oldCat = row[4] || CONFIG.DEFAULT_CATEGORY;
      var newCat = determineCategory(merchant);
      totalRows++;
      if (oldCat !== newCat) {
        changedCount++;
        if (oldCat === CONFIG.DEFAULT_CATEGORY) fromOtherCount++;
        else betweenCatsCount++;
        if (sampleChanges.length < 5) {
          sampleChanges.push(merchant + ":「" + oldCat + "」→「" + newCat + "」");
        }
      }
    });
  });

  if (changedCount === 0) {
    ui.alert("✅ 全部分類都已是最新規則,無需更新。\n\n總交易筆數:" + totalRows);
    return;
  }

  // ----- Step 2: 確認 -----
  var confirmMsg = "📊 重新分類預覽\n\n" +
    "總交易筆數:" + totalRows + "\n" +
    "將更新分類:" + changedCount + " 筆\n" +
    "  ├─ 從「其他」轉具體分類:" + fromOtherCount + " 筆\n" +
    "  └─ 具體分類之間調整:" + betweenCatsCount + " 筆\n\n" +
    "前 5 筆變動範例:\n" + sampleChanges.join("\n") + "\n\n" +
    "⚠️ 此操作會直接覆寫各年度工作表的「分類」欄。建議先在副本測試。\n\n是否繼續?";

  var response = ui.alert("確認重新分類", confirmMsg, ui.ButtonSet.YES_NO);
  if (response !== ui.Button.YES) {
    ui.alert("已取消,沒有任何變動。");
    return;
  }

  // ----- Step 3: 實際寫入 (🔒 V4.1 上鎖) -----
  var actualChanged = 0;
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    yearSheets.forEach(function (sheet) {
      var lastRow = sheet.getLastRow();
      if (lastRow < 2) return;
      var range = sheet.getRange(2, 1, lastRow - 1, 6);
      var data = range.getValues();
      var modified = false;

      data.forEach(function (row) {
        var merchant = (row[3] || "").toString();
        var oldCat = row[4] || CONFIG.DEFAULT_CATEGORY;
        var newCat = determineCategory(merchant);
        if (oldCat !== newCat) {
          row[4] = newCat;
          actualChanged++;
          modified = true;
        }
      });

      if (modified) {
        range.setValues(data);
      }
    });

    // ----- Step 4: 同步刷新戰情室 -----
    updateUnifiedWarRoom();
  } finally {
    lock.releaseLock();
  }

  ui.alert("✅ 完成!\n\n" +
    "已更新 " + actualChanged + " 筆交易的分類。\n" +
    "戰情室已同步刷新。\n\n" +
    "建議再跑一次「🔍 Tail Spend 診斷」看新的未分類比例。"
  );
}

function onOpen() {
  SpreadsheetApp.getUi().createMenu('💰 記帳小幫手')
    .addItem('📩 立即抓信', 'processConsolidatedEmails')
    .addItem('🔄 刷新總戰情室', 'updateUnifiedWarRoom')
    .addSeparator()
    .addItem('🔍 Tail Spend 診斷', 'analyzeUnclassified')
    .addItem('📖 建立分類覆寫表', 'createOverrideSheet')
    .addItem('♻️ 重新分類所有交易', 'reclassifyAllRows')
    .addToUi();
}
