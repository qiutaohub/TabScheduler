document.addEventListener('DOMContentLoaded', async () => {
    // 元素引用
    const els = {
        urls: document.getElementById('urls'),
        cycleType: document.getElementById('cycleType'),
        daySelect: document.getElementById('daySelect'),
        timeSelect: document.getElementById('timeSelect'),
        gotifyUrl: document.getElementById('gotifyUrl'),
        gotifyToken: document.getElementById('gotifyToken'),
        showToken: document.getElementById('showToken'), // 新增：显示Token的复选框
        logs: document.getElementById('logs'),
        saveBtn: document.getElementById('saveBtn'),
        runNowBtn: document.getElementById('runNowBtn'),
        clearLogs: document.getElementById('clearLogs')
    };

    // 加载保存的设置
    const data = await chrome.storage.local.get(['config', 'logs']);
    if (data.config) {
        els.urls.value = data.config.urls.join('\n');
        els.cycleType.value = data.config.cycleType;
        els.timeSelect.value = data.config.time;
        els.gotifyUrl.value = data.config.gotifyUrl || '';
        els.gotifyToken.value = data.config.gotifyToken || '';
        updateDaySelect(data.config.cycleType, data.config.day);
    } else {
        updateDaySelect('daily');
    }
    renderLogs(data.logs || []);

    // 监听周期类型变化，更新下拉框
    els.cycleType.addEventListener('change', (e) => updateDaySelect(e.target.value));

    // --- 修改点：监听显示Token复选框变化 ---
    els.showToken.addEventListener('change', (e) => {
        els.gotifyToken.type = e.target.checked ? 'text' : 'password';
    });
    // ------------------------------------

    // 保存设置
    els.saveBtn.addEventListener('click', async () => {
        const config = getConfigFromUI();
        if (!config) return;

        await chrome.storage.local.set({ config });
        // 通知后台重新调度
        chrome.runtime.sendMessage({ action: 'UPDATE_SCHEDULE' });
        alert('设置已保存，定时任务已更新！');
    });

    // 立即执行
    els.runNowBtn.addEventListener('click', () => {
        const config = getConfigFromUI();
        if (!config) return;
        // 即使立即执行，也先保存配置
        chrome.storage.local.set({ config }); 
        chrome.runtime.sendMessage({ action: 'RUN_NOW' });
    });

    // 清空日志
    els.clearLogs.addEventListener('click', async () => {
        await chrome.storage.local.set({ logs: [] });
        renderLogs([]);
    });

    // 监听日志更新
    chrome.storage.onChanged.addListener((changes) => {
        if (changes.logs) renderLogs(changes.logs.newValue);
    });

    // --- 辅助函数 ---

    function getConfigFromUI() {
        const urls = els.urls.value.split('\n').map(u => u.trim()).filter(u => u);
        if (urls.length === 0) {
            alert('请至少填写一个网址');
            return null;
        }
        const time = els.timeSelect.value;
        if (!time) {
            alert('请选择时间');
            return null;
        }

        return {
            urls,
            cycleType: els.cycleType.value,
            day: els.daySelect.value, // 可能为空（如果是daily）
            time,
            gotifyUrl: els.gotifyUrl.value.trim(),
            gotifyToken: els.gotifyToken.value.trim()
        };
    }

    function updateDaySelect(type, savedValue = null) {
        els.daySelect.innerHTML = '';
        els.daySelect.classList.remove('hidden');

        if (type === 'daily') {
            els.daySelect.classList.add('hidden');
        } else if (type === 'weekly') {
            const days = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
            days.forEach((d, i) => {
                const opt = new Option(d, i); // 0-6
                els.daySelect.add(opt);
            });
            if (savedValue !== null) els.daySelect.value = savedValue;
        } else if (type === 'monthly') {
            for (let i = 1; i <= 31; i++) {
                const opt = new Option(`${i}号`, i);
                els.daySelect.add(opt);
            }
            if (savedValue !== null) els.daySelect.value = savedValue;
        }
    }

    function renderLogs(logs) {
        if (!logs || logs.length === 0) {
            els.logs.innerText = '无日志';
            return;
        }
        // 最新的在上面
        els.logs.innerText = logs.slice().reverse().map(l => `[${new Date(l.time).toLocaleString()}] ${l.msg}`).join('\n');
    }
});
