/*
 * TabScheduler Background Script
 * V12: 动态 declarativeNetRequest 规则以兼容 Cloudflare 403
 */

const ALARM_SCHEDULER = 'TASK_SCHEDULER';
const ALARM_CLEANUP_PREFIX = 'TASK_CLEANUP_';
const CLOSE_DELAY_MINUTES = 10; // 这里定义时间
const LOG_LIMIT = 50;

let isTaskRunning = false;

// === 0. 动态更新 declarativeNetRequest 规则 ===
// 这个函数负责根据用户配置的 Gotify URL，动态地设置或移除一个 declarativeNetRequest 规则。
// 规则目的是移除 chrome-extension:// 开头的 Origin 头，以解决 Cloudflare 等 WAF 的 403 阻断。
async function updateGotifyDeclarativeRule() {
    try {
        const data = await chrome.storage.local.get('config');
        const config = data.config;
        
        let gotifyMessageUrl = null;
        if (config && config.gotifyUrl) {
            let rawUrl = config.gotifyUrl.trim();
            // 确保 Gotify URL 有协议头
            if (!rawUrl.startsWith('http://') && !rawUrl.startsWith('https://')) {
                rawUrl = 'https://' + rawUrl; // 默认使用 HTTPS，用户可在配置中修改
            }

            // 检查URL是否已经包含/message
            if (rawUrl.endsWith('/message')) {
                gotifyMessageUrl = rawUrl;
            } else if (rawUrl.endsWith('/')) {
                gotifyMessageUrl = `${rawUrl}message`;
            } else {
                gotifyMessageUrl = `${rawUrl}/message`;
            }
        }

        if (gotifyMessageUrl) {
            log(`更新 Gotify 请求规则，目标 URL: ${gotifyMessageUrl}*`);
            chrome.declarativeNetRequest.updateDynamicRules({
                removeRuleIds: [10001], // 移除旧规则（如果存在）
                addRules: [{
                    id: 10001,
                    priority: 1, // 优先级
                    action: {
                        type: "modifyHeaders",
                        requestHeaders: [{
                            header: "Origin",
                            operation: "remove" // 移除 Origin 请求头
                        }]
                    },
                    condition: {
                        urlFilter: `${gotifyMessageUrl}*`, // 动态匹配你的 Gotify 消息URL，并支持查询字符串
                        resourceTypes: ["xmlhttprequest"] // 针对 XMLHttpRequest 和 fetch 请求
                    }
                }]
            });
        } else {
            // 如果 Gotify URL 未配置，或者被清空，则移除规则
            // 这确保了在未配置 Gotify 时不会有不必要的规则，且在用户清空 Gotify 配置时规则也被移除
            log("Gotify URL 未配置或无效，移除 Gotify 请求规则（如果存在）。");
            chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: [10001] });
        }
    } catch (e) {
        logError(`Gotify declarativeNetRequest 规则更新失败: ${e.message}`);
    }
}

// === 1. 监听扩展安装/更新 ===
chrome.runtime.onInstalled.addListener(() => {
    updateGotifyDeclarativeRule(); // 确保扩展安装或更新时应用规则
});

// === 2. 监听消息 ===
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.action === 'UPDATE_SCHEDULE') {
        scheduleNextRun(); // 更新任务调度，并在此内部调用 updateGotifyDeclarativeRule
        sendResponse({ status: 'ok' });
    } else if (msg.action === 'RUN_NOW') {
        executeTask('手动执行');
        sendResponse({ status: 'ok' });
    }
    return true; 
});

// === 3. 监听定时器 ===
chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === ALARM_SCHEDULER) {
        log('定时任务触发');
        executeTask('定时自动执行');
        scheduleNextRun();
    } else if (alarm.name.startsWith(ALARM_CLEANUP_PREFIX)) {
        const batchId = alarm.name.replace(ALARM_CLEANUP_PREFIX, '');
        closeOpenedTabs(batchId);
    }
});

// === 4. 调度逻辑 ===
async function scheduleNextRun() {
    try {
        const data = await chrome.storage.local.get('config');
        const config = data.config;
        
        await chrome.alarms.clear(ALARM_SCHEDULER);

        if (!config) return;

        const nextRunTime = calculateNextTime(config);
        if (nextRunTime) {
            log(`下次任务时间设定为: ${new Date(nextRunTime).toLocaleString()}`);
            chrome.alarms.create(ALARM_SCHEDULER, { when: nextRunTime });
        }
        
        // 每次调度或保存配置后也更新 Gotify declarativeNetRequest 规则
        // 这很重要，因为用户可能在 popup 保存配置时修改了 Gotify URL
        await updateGotifyDeclarativeRule(); 

    } catch (e) {
        logError(`调度失败: ${e.message}`);
    }
}

// === 5. 执行打开 (恢复直观日志) ===
async function executeTask(triggerSource) {
    if (isTaskRunning) {
        console.warn('任务正在运行中，已忽略本次请求。');
        return;
    }
    isTaskRunning = true;

    try {
        const data = await chrome.storage.local.get('config');
        const config = data.config;
        if (!config || !config.urls) throw new Error('无有效配置');

        log(`开始任务 (${triggerSource})...`);

        const openedTabIds = [];
        const uniqueUrls = [...new Set(config.urls)].filter(u => u && u.trim() !== "");

        if (uniqueUrls.length === 0) {
            log("没有配置有效的网址，跳过执行。");
            return;
        }

        for (const url of uniqueUrls) {
            try {
                let targetUrl = url.trim();
                // 确保 URL 带有协议，否则 chrome.tabs.create 会视其为搜索
                if (!targetUrl.startsWith('http://') && !targetUrl.startsWith('https://')) {
                    targetUrl = 'http://' + targetUrl; // 默认使用 HTTP，用户需自行确保或使用HTTPS
                }
                const tab = await chrome.tabs.create({ url: targetUrl, active: false });
                if (tab && tab.id) openedTabIds.push(tab.id);
            } catch (err) {
                logError(`打开网址失败 [${url}]: ${err.message}`);
            }
        }

        const batchId = Date.now().toString();
        await chrome.storage.local.set({ [`batch_${batchId}`]: openedTabIds });
        
        // 设定定时器
        chrome.alarms.create(ALARM_CLEANUP_PREFIX + batchId, { delayInMinutes: CLOSE_DELAY_MINUTES });
        
        // === 恢复：原来直观的日志 ===
        log(`已打开 ${openedTabIds.length} 个网页，将在 ${CLOSE_DELAY_MINUTES} 分钟后关闭。`);
        
    } catch (e) {
        logError(`执行任务失败: ${e.message}`);
    } finally {
        isTaskRunning = false;
    }
}

// === 6. 执行关闭与通知 ===
async function closeOpenedTabs(batchId) {
    try {
        const key = `batch_${batchId}`;
        const data = await chrome.storage.local.get([key, 'config']);
        const tabIds = data[key];
        const config = data.config;

        if (tabIds && tabIds.length > 0) {
            log(`正在关闭网页 (批次: ${batchId})...`);
            // 不管tab还在不在，都尝试关闭
            // 使用 Promise.allSettled 确保即使有些tab id无效也不会中断整个关闭操作
            const removePromises = tabIds.map(id => chrome.tabs.remove(id).catch((e) => {
                // 捕获并忽略"No tab with id X"之类的错误，因为用户可能手动关闭了
                console.warn(`无法关闭Tab ${id}: ${e.message}`);
            }));
            await Promise.allSettled(removePromises); // 等待所有 Promise 完成，不管成功失败
            log(`网页自动关闭完成。`);
        } else {
             log(`没有找到批次 ${batchId} 的活动网页需要关闭。`);
        }

        // 清理缓存
        chrome.storage.local.remove(key);

        // 发送通知
        if (config && config.gotifyUrl && config.gotifyToken) {
            // 稍微延时一点点，确保日志先写完
            setTimeout(() => {
                sendGotifyHelper(config, "网站轮巡通知", "网页轮巡任务结束，相关页面已关闭。");
            }, 1000);
        }
    } catch (e) {
        logError(`自动处理失败: ${e.message}`);
    }
}

// === 7. 时间计算逻辑 (保持不变) ===
function calculateNextTime(config) {
    const now = new Date();
    if (!config.time || !config.time.includes(':')) return null;
    const [targetH, targetM] = config.time.split(':').map(Number);
    let targetDate = new Date();
    targetDate.setHours(targetH, targetM, 0, 0);

    if (config.cycleType === 'daily') {
        if (targetDate <= now) targetDate.setDate(targetDate.getDate() + 1);
    } else if (config.cycleType === 'weekly') {
        const targetDay = parseInt(config.day);
        const currentDay = now.getDay();
        let diff = targetDay - currentDay;
        // 如果目标日小于当前日，或者等于当前日但目标时间已过，则加7天
        if (diff < 0 || (diff === 0 && targetDate <= now)) diff += 7;
        targetDate.setDate(now.getDate() + diff);
    } else if (config.cycleType === 'monthly') {
        const targetDay = parseInt(config.day);
        targetDate.setDate(targetDay);
        if (targetDate <= now) {
            // 如果目标日期已过，或者等于当前日期但目标时间已过，则设置为下个月
            targetDate = new Date(now.getFullYear(), now.getMonth() + 1, targetDay, targetH, targetM, 0);
        }
    }
    return targetDate.getTime();
}

// === 8. Gotify 发送逻辑 (根据官方文档修改请求体格式) ===
async function sendGotifyHelper(config, title, message) {
    let rawUrl = config.gotifyUrl.trim();
    if (!rawUrl.startsWith('http://') && !rawUrl.startsWith('https://')) {
        rawUrl = 'https://' + rawUrl;
    }

    // 确保 Gotify URL 构造正确，并始终以 /message 结尾
    let baseUrl = rawUrl;
    if (!rawUrl.endsWith('/message') && !rawUrl.endsWith('/')) {
        baseUrl += '/';
    }
    if (!baseUrl.endsWith('message')) {
        baseUrl += 'message';
    }
    
    const token = config.gotifyToken.trim();

    if (token.startsWith('C')) {
        logError("Gotify配置错误：你填的是Client Token (C开头)，它只能收消息。请在Gotify后台新建一个 Application 并在那里获取 App Token (A开头)！");
        return;
    }

    try {
        const urlObj = new URL(baseUrl);
        urlObj.searchParams.append('token', token); // Token 作为 URL 参数传递

        // --- 关键修改 START ---
        // 根据 Gotify 官方文档，请求体应为 form-urlencoded 格式
        const params = new URLSearchParams();
        params.append('title', title);
        params.append('message', message);
        params.append('priority', '5'); // 优先级也作为参数

        const response = await fetch(urlObj.toString(), {
            method: "POST",
            headers: {
                // 修改 Content-Type 为 form-urlencoded
                "Content-Type": "application/x-www-form-urlencoded", 
                // "Content-Type": "application/json", // <-- 废弃，不再使用JSON
            },
            body: params.toString(), // 将 URLSearchParams 对象转换为字符串作为请求体
            credentials: 'omit', 
            mode: 'cors'
        });
        // --- 关键修改 END ---

        if (!response.ok) {
            const errText = await response.text();
            throw new Error(`HTTP ${response.status}: ${errText || '未知错误响应'}`);
        }
        
        log("Gotify 通知发送成功");

    } catch (e) {
        logError(`Gotify发送失败: ${e.message}`);
    }
}



// === 9. 日志工具 ===
async function log(msg) {
    console.log('[TabScheduler]', msg);
    await appendLog(msg);
}

async function logError(msg) {
    console.error('[TabScheduler]', msg);
    await appendLog('ERROR: ' + msg);
}

async function appendLog(msg) {
    try {
        const data = await chrome.storage.local.get('logs');
        const logs = data.logs || [];
        // 日志显示时间
        const timeStr = new Date().toLocaleString('zh-CN', {hour12: false});
        logs.push({ time: Date.now(), msg: `[${timeStr}] ${msg}` });
        
        if (logs.length > LOG_LIMIT) logs.shift();
        await chrome.storage.local.set({ logs });
    } catch (e) {
        // ignore for logging errors
    }
}
