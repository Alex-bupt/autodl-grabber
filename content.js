/* AutoDL standard-container clone page UI automation. No network API or tokens. */
(function () {
  'use strict';
  const core = globalThis.AutoDLCloneGrabCore;
  if (!core || window.top !== window || document.getElementById('autodl-clone-grabber-panel')) return;

  // Bind this task to the source in the current clone link, not an old instance.
  const SOURCE_ID = new URL(location.href).searchParams.get('id') || '';
  const VERSION = chrome.runtime?.getManifest?.().version || '1.3.2';
  const RUN_KEY = 'autodl_clone_grab_run_' + SOURCE_ID;
  const PENDING_KEY = 'autodl_clone_grab_pending_' + SOURCE_ID;
  const SETTINGS_KEY = 'autodl_clone_grab_settings_' + SOURCE_ID;
  const TAB_KEY = 'autodl_clone_grab_tab_' + SOURCE_ID;
  const LOCK_NAME = 'autodl_clone_grab_lock_' + SOURCE_ID;
  let tabToken = sessionStorage.getItem(TAB_KEY);
  if (!tabToken) { tabToken = crypto.randomUUID(); sessionStorage.setItem(TAB_KEY, tabToken); }
  const ACTIVE_KEY = 'autodl_clone_grab_active_' + SOURCE_ID + '_' + tabToken;
  const HOSTS_PER_MODEL = 3;
  const MAX_VIEW_RESTARTS = 3;
  let working = false;
  let busy = true;
  let serial = 0;

  class InventoryViewChanged extends Error {
    constructor() { super('地区或显卡列表已变化'); }
  }
  const sameModel = (a, b) => core.modelKey(a) === core.modelKey(b);

  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  const running = () => ['1', 'check'].includes(sessionStorage.getItem(RUN_KEY));
  const checkingOnly = () => sessionStorage.getItem(RUN_KEY) === 'check';
  const storage = chrome.storage.local;
  const ledger = {
    async getPending() {
      const stored = (await storage.get(PENDING_KEY))[PENDING_KEY];
      // Earlier versions stored this marker in the site's localStorage.
      return stored || localStorage.getItem(PENDING_KEY);
    },
    markPending: value => storage.set({ [PENDING_KEY]: value }),
    async clearPending() { await storage.remove(PENDING_KEY); localStorage.removeItem(PENDING_KEY); },
  };

  const panel = document.createElement('section');
  panel.id = 'autodl-clone-grabber-panel';
  panel.style.cssText = 'position:fixed;z-index:2147483000;right:16px;top:72px;width:360px;max-height:calc(100vh - 100px);overflow:auto;padding:14px;background:#fff;border:2px solid #5367de;border-radius:10px;box-shadow:0 3px 16px #0003;color:#20243a;font:13px/1.55 Arial,sans-serif';
  panel.innerHTML = '<strong style="font-size:15px">AutoDL 克隆抢机助手 v' + VERSION + '</strong>' +
    '<div style="margin:5px 0">区域跟随克隆页面 · 单卡 · 按量计费</div>' +
    '<div>先排除显存不足的型号，再检查库存和主机。</div>' +
    '<div>勾选具体 GPU 后，仅检查列表置顶 3 台主机。</div>' +
    '<div>自动识别当前地区的型号，列表变化后重新检查。</div>' +
    '<div data-source style="overflow-wrap:anywhere"></div>' +
    '<div style="display:grid;grid-template-columns:1fr 1fr;gap:6px 10px">' +
      '<label>最低单卡显存 (GB)<input data-setting="minVramGB" type="number" min="1" max="1024" step="1" style="width:100%;box-sizing:border-box"></label>' +
      '<label>最低可扩容 (GB)<input data-setting="minExpandableGB" type="number" min="0" max="100000" step="1" style="width:100%;box-sizing:border-box"></label>' +
      '<label>实际扩容 (GB)<input data-setting="expandGB" type="number" min="0" max="100000" step="1" style="width:100%;box-sizing:border-box"></label>' +
      '<label>单卡上限 (元/时)<input data-setting="maxHourlyCny" type="number" min="0.01" step="0.01" style="width:100%;box-sizing:border-box"></label>' +
      '<label>刷新间隔 (秒)<input data-setting="refreshSeconds" type="number" min="1" max="3600" step="1" style="width:100%;box-sizing:border-box"></label>' +
      '<label>最低 CUDA<input data-setting="cudaVersion" type="text" placeholder="12.8" style="width:100%;box-sizing:border-box"></label>' +
    '</div>' +
    '<div style="margin-top:5px">扩容填 0 表示不扩容；每轮检查完成后开始倒计时。</div>' +
    '<div style="color:#9a4c0b">仅克隆系统盘；数据盘需稍后手动复制。</div>' +
    '<div style="margin:10px 0"><button type="button" data-action="save">保存设置</button> <button type="button" data-action="check">仅检查（不创建）</button> <button type="button" data-action="start">开始自动抢</button> <button type="button" data-action="stop">停止</button> <button type="button" data-action="reset">检查后重置提交状态</button></div>' +
    '<div data-status style="white-space:pre-wrap;overflow-wrap:anywhere">正在读取设置…</div>';
  document.documentElement.appendChild(panel);
  panel.querySelector('[data-source]').textContent = '源实例：' + (SOURCE_ID || '未识别');
  const statusNode = panel.querySelector('[data-status]');
  const startButton = panel.querySelector('[data-action="start"]');
  const checkButton = panel.querySelector('[data-action="check"]');
  const stopButton = panel.querySelector('[data-action="stop"]');
  const resetButton = panel.querySelector('[data-action="reset"]');
  const saveButton = panel.querySelector('[data-action="save"]');
  const fields = [...panel.querySelectorAll('[data-setting]')];

  function syncControls() {
    const locked = busy || working || running();
    for (const field of fields) field.disabled = locked;
    saveButton.disabled = locked;
    startButton.disabled = locked;
    checkButton.disabled = locked;
    resetButton.disabled = locked;
    stopButton.disabled = busy || (!working && !running());
  }

  function setFields(settings) {
    for (const field of fields) {
      const name = field.dataset.setting;
      field.value = name === 'cudaVersion' ? settings.minCudaMajor + '.' + settings.minCudaMinor : String(settings[name]);
    }
  }

  function readFields() {
    const field = name => panel.querySelector('[data-setting="' + name + '"]').value.trim();
    const number = name => {
      const value = field(name);
      if (!value) throw new Error('所有设置项都需要填写');
      return Number(value);
    };
    const cuda = field('cudaVersion').match(/^(\d{1,2})\.(\d{1,2})$/);
    if (!cuda) throw new Error('最低 CUDA 请填写版本号，例如 12.8');
    return core.validateSettings({
      minVramGB: number('minVramGB'), minExpandableGB: number('minExpandableGB'),
      expandGB: number('expandGB'), maxHourlyCny: number('maxHourlyCny'),
      refreshSeconds: number('refreshSeconds'), minCudaMajor: Number(cuda[1]), minCudaMinor: Number(cuda[2]),
      requestedGPUs: 1,
    });
  }

  function status(message) {
    statusNode.textContent = new Date().toLocaleTimeString() + ' ' + message;
  }

  async function stop(message) {
    sessionStorage.removeItem(RUN_KEY);
    serial++;
    status(message);
    syncControls();
    try { await storage.remove(ACTIVE_KEY); }
    catch (_) { status(message + '（无法清除运行配置，请检查扩展权限）'); }
  }

  function assertRunning(id) {
    if (!running() || id !== serial) throw new Error('已停止');
  }

  function verifyUrl() {
    if (core.cloneSourceId(location.href) !== SOURCE_ID) {
      throw new Error('源实例已切换，请刷新页面后重新开始');
    }
    const u = new URL(location.href);
    const dataCopy = (u.searchParams.get('copy_data_disk') || '').trim().toLowerCase();
    if (!['', '0', 'false'].includes(dataCopy)) throw new Error('链接启用了数据盘复制，与当前设置不符');
  }

  function verifyPage() {
    verifyUrl();
    const source = [...document.querySelectorAll('.noMachine')].some(e => e.innerText.includes(SOURCE_ID));
    if (!source) throw new Error('页面未确认指定源实例，可能需要登录或页面已改版');
    const payg = [...document.querySelectorAll('label.el-radio-button')].find(e => e.querySelector('input')?.value === 'payg');
    const single = [...document.querySelectorAll('label.el-radio-button')].find(e => e.querySelector('input')?.value === '1');
    if (!payg || payg.getAttribute('aria-checked') !== 'true') throw new Error('当前不是按量计费');
    if (!single || single.getAttribute('aria-checked') !== 'true') throw new Error('当前不是单卡配置');
  }

  function visible(element) {
    const r = element.getBoundingClientRect(), css = getComputedStyle(element);
    return r.width > 0 && r.height > 0 && css.display !== 'none' && css.visibility !== 'hidden';
  }

  function gpuLabels() {
    return [...document.querySelectorAll('label.el-checkbox')].flatMap(label => {
      const input = label.querySelector('input[type="checkbox"]');
      if (!input || !visible(label)) return [];
      const parsed = core.parseModelChoice(label.innerText);
      return parsed ? [{ ...parsed, disabled: input.disabled || label.classList.contains('is-disabled'), input, label }] : [];
    });
  }

  function inventoryViewKey() {
    const url = new URL(location.href);
    const selected = [...document.querySelectorAll('label.el-radio-button')]
      .filter(label => visible(label) && (label.getAttribute('aria-checked') === 'true' || label.querySelector('input')?.checked))
      .map(label => [label.querySelector('input')?.value || '', label.innerText.trim()]).sort();
    // Counts and GPU checkbox selection may change while scanning. Only the
    // current page context and visible model set identify this inventory view.
    return JSON.stringify([url.searchParams.get('id'), url.searchParams.get('region'), selected,
      gpuLabels().map(choice => core.modelKey(choice.name)).sort()]);
  }

  function assertActiveView(id, view) {
    assertRunning(id);
    verifyUrl();
    if (inventoryViewKey() !== view) throw new InventoryViewChanged();
  }

  async function waitForPage(id) {
    verifyUrl();
    for (let n = 0; n < 80; n++) {
      assertRunning(id);
      const sourceReady = [...document.querySelectorAll('.noMachine')].some(e => e.innerText.includes(SOURCE_ID));
      if (sourceReady && gpuLabels().length) {
        verifyPage();
        return;
      }
      status('等待 AutoDL 页面加载…');
      await delay(250);
    }
    throw new Error('页面加载超时：请确认源实例 ' + SOURCE_ID + ' 和 GPU 型号列表已显示，并检查登录状态');
  }

  function liveRows() {
    // Limit physical row positions before parsing, so invalid rows do not
    // pull the fourth or later host into the top-three window.
    return [...document.querySelectorAll('table.el-table__body tbody tr')].slice(0, HOSTS_PER_MODEL).flatMap(row => {
      const cells = [...row.querySelectorAll('td')].map(cell => cell.innerText);
      const input = row.querySelector('input[type="radio"]');
      const enabled = !!input && !input.disabled && input.value !== '0';
      const host = core.parseHost(cells, enabled);
      return host ? [{ host, row, input }] : [];
    });
  }

  async function setOnlyModel(model, id, settings, view) {
    assertActiveView(id, view);
    if (!core.stockedModelChoices(gpuLabels(), settings).some(choice => sameModel(choice.name, model))) return false;
    const all = [...document.querySelectorAll('label.el-checkbox')].find(label => {
      const input = label.querySelector('input');
      return input && visible(label) && label.innerText.trim() === '全部' && input.checked;
    });
    if (all) { all.click(); await delay(350); }
    for (const choice of gpuLabels()) {
      assertActiveView(id, view);
      if (choice.input.checked && !sameModel(choice.name, model)) { choice.label.click(); await delay(350); }
    }
    assertActiveView(id, view);
    const target = gpuLabels().find(item => sameModel(item.name, model));
    if (!target) throw new InventoryViewChanged();
    // Clearing other filters can update counts. Never select a now-empty model.
    if (!core.stockedModelChoices([target], settings).length) return false;
    if (!target.input.checked) { target.label.click(); await delay(350); }
    await delay(1200);
    assertActiveView(id, view);
    const active = gpuLabels().filter(item => item.input.checked);
    if (active.length !== 1 || !sameModel(active[0].name, model)) throw new Error('GPU 筛选状态无法确认');
    const wrapper = document.querySelector('.el-table__body-wrapper');
    if (!wrapper) throw new Error('找不到主机列表滚动区域');
    wrapper.scrollTop = 0;
    return true;
  }

  async function scanModel(model, id, settings, view) {
    if (!(await setOnlyModel(model, id, settings, view))) return null;
    assertActiveView(id, view);
    const candidate = liveRows().find(item => sameModel(item.host.model, model) && core.qualifies(item.host, settings));
    if (!candidate) status(model + ' 置顶 3 台主机无符合条件的候选，检查下一型号。');
    return candidate?.host || null;
  }

  function visibleMessages() {
    return [...document.querySelectorAll('.el-message, .el-notification, .el-message-box__wrapper, .el-dialog__wrapper, [role="alertdialog"]')]
      .filter(element => visible(element) && !panel.contains(element))
      // Read the actual dialog message, excluding title and footer buttons.
      .map(element => (element.querySelector('.el-message-box__message, .el-dialog__body') || element).innerText.trim()).filter(Boolean);
  }

  function visibleDialog() {
    return [...document.querySelectorAll('.el-message-box__wrapper, .el-dialog__wrapper, [role="alertdialog"]')]
      .some(element => visible(element) && !panel.contains(element));
  }

  function adapter(id, model, settings, view) {
    return {
      async selectHost(hostId) {
        assertActiveView(id, view);
        verifyPage();
        if (visibleDialog()) throw new Error('页面有未处理的弹窗，请先处理');
        const item = liveRows().find(row => row.host.id === hostId && sameModel(row.host.model, model));
        if (!item || !core.qualifies(item.host, settings)) throw new Error('主机已不可选');
        const label = item.row.querySelector('label.el-radio');
        if (!label) throw new Error('找不到主机选择控件');
        label.click();
        await delay(900);
        assertActiveView(id, view);
        const selected = liveRows().find(row => row.host.id === hostId && sameModel(row.host.model, model));
        if (!selected?.input.checked) throw new Error('主机选择未生效');
      },
      async setExpansion(gb) {
        assertActiveView(id, view);
        const label = [...document.querySelectorAll('label.el-checkbox')].find(e =>
          e.querySelector('input[type="checkbox"]')?.value === '需要扩容');
        if (!label) throw new Error('找不到数据盘扩容开关');
        if (gb === 0) {
          if (label.querySelector('input').checked) { label.click(); await delay(300); }
          assertActiveView(id, view);
          if (label.querySelector('input').checked) throw new Error('未能取消数据盘扩容');
          return;
        }
        if (!label.querySelector('input').checked) { label.click(); await delay(300); }
        assertActiveView(id, view);
        const input = document.querySelector('input[role="spinbutton"]');
        if (!input || input.disabled || !input.hasAttribute('max') || Number(input.getAttribute('max')) < gb ||
            (input.hasAttribute('min') && Number(input.getAttribute('min')) > gb)) {
          throw new Error('数据盘输入框未确认可扩容 ' + gb + 'GB');
        }
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        setter.call(input, String(gb));
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        input.blur();
        await delay(700);
        assertActiveView(id, view);
        if (Number(input.value) !== gb || !label.querySelector('input').checked) throw new Error(gb + 'GB 扩容设置未生效');
      },
      async readHost(hostId) {
        assertActiveView(id, view);
        return liveRows().find(row => row.host.id === hostId && sameModel(row.host.model, model))?.host || null;
      },
      async verifyForm(host, limits) {
        assertActiveView(id, view);
        verifyPage();
        if (visibleDialog()) throw new Error('页面有未处理的弹窗');
        const selected = liveRows().find(row => row.host.id === host.id);
        if (!selected?.input.checked || !sameModel(selected.host.model, model) || !core.qualifies(selected.host, limits)) throw new Error('提交前主机检查失败');
        const spin = document.querySelector('input[role="spinbutton"]');
        const disk = [...document.querySelectorAll('label.el-checkbox')].find(e => e.querySelector('input')?.value === '需要扩容');
        if (!disk?.querySelector('input')) throw new Error('提交前数据盘检查失败');
        if (limits.expandGB === 0) {
          if (disk.querySelector('input').checked) throw new Error('提交前未取消数据盘扩容');
        } else if (!spin || Number(spin.value) !== limits.expandGB || !disk.querySelector('input').checked) {
          throw new Error('提交前数据盘检查失败');
        }
        const button = [...document.querySelectorAll('button')].find(e => e.innerText.trim() === '创建并开机' && visible(e));
        if (!button || button.disabled) throw new Error('创建按钮不可用');
      },
      submit() {
        assertActiveView(id, view);
        // The durable marker was recorded before this single click.
        const button = [...document.querySelectorAll('button')].find(e => e.innerText.trim() === '创建并开机' && visible(e));
        if (!button || button.disabled) throw new Error('创建按钮不可用');
        button.click();
      },
    };
  }

  async function waitForResult(oldMessages, id) {
    for (let n = 0; n < 30; n++) {
      await delay(1000);
      assertRunning(id);
      const fresh = visibleMessages().filter(message => !oldMessages.includes(message));
      // A simultaneous success report always prevents automatic resubmission.
      const success = fresh.find(message => /创建成功|克隆成功/.test(message));
      if (success) return { kind: 'success', message: success };
      const stockFailure = fresh.find(message => core.definiteStockFailure(message));
      if (stockFailure) return { kind: 'no-stock', message: stockFailure };
      if (visibleDialog()) return { kind: 'attention', message: '页面要求进一步确认，请查看弹窗。' };
      if (fresh.length) return { kind: 'attention', message: fresh.join('；') };
    }
    return { kind: 'attention', message: '提交结果尚不明确，请检查实例列表，避免重复创建。' };
  }

  async function countdownAndReload(id, settings, reason = '本轮未找到符合条件的主机') {
    if (checkingOnly()) {
      await stop('仅检查完成：' + reason + '；未创建实例，也不会自动刷新。');
      return;
    }
    for (let left = settings.refreshSeconds; left > 0; left--) {
      assertRunning(id);
      status(reason + '，' + left + ' 秒后刷新。');
      await delay(1000);
    }
    assertRunning(id);
    const hasPending = await ledger.getPending();
    assertRunning(id);
    if (!hasPending) location.reload();
  }

  async function monitorView(id, settings, view) {
    const checked = new Set();
    for (;;) {
      assertActiveView(id, view);
      // Rebuild the queue from the current region every time. A model with
      // zero stock at round start can become available while another is read.
      const choices = gpuLabels();
      if (!choices.length) throw new InventoryViewChanged();
      const choice = core.stockedModelChoices(choices, settings)
        .find(item => !checked.has(core.modelKey(item.name)));
      if (!choice) {
        if (checked.size) return countdownAndReload(id, settings);
        const hasStock = choices.some(item => item.free >= settings.requestedGPUs);
        return countdownAndReload(id, settings, hasStock ? '型号栏有库存，但暂无可选且符合显存要求的型号' : '型号栏空闲库存为 0，等待补货');
      }
      checked.add(core.modelKey(choice.name));
      status('库存确认：' + choice.name + ' 有 ' + choice.free + ' 张空闲卡，正在勾选并检查主机。');
      const host = await scanModel(choice.name, id, settings, view);
      if (!host) continue;
      const oldMessages = visibleMessages();
      status('发现 ' + host.model + ' ' + host.vramGB + 'GB，¥' + host.hourlyCny + '/时，正在核验表单。');
      if (checkingOnly()) {
        const current = await core.prepareOne(host, adapter(id, choice.name, settings, view), settings);
        await stop('仅检查完成：' + current.model + ' ' + current.vramGB + 'GB，¥' + current.hourlyCny + '/时；主机选择、' + settings.expandGB + 'GB 扩容和提交前检查通过，未创建实例。');
        return;
      }
      await core.submitOne(host, adapter(id, choice.name, settings, view), ledger, settings);
      const result = await waitForResult(oldMessages, id);
      if (result.kind === 'no-stock') {
        await ledger.clearPending();
        return countdownAndReload(id, settings, '平台明确返回库存不足或库存变更，刷新后重新选择');
      }
      await stop(result.kind === 'success' ? '平台报告创建成功；请到实例列表确认。' : result.message);
      return;
    }
  }

  async function monitor(id, settings) {
    for (let restart = 0; restart <= MAX_VIEW_RESTARTS; restart++) {
      await waitForPage(id);
      await delay(1500);
      assertRunning(id);
      const view = inventoryViewKey();
      try {
        return await monitorView(id, settings, view);
      } catch (error) {
        if (!(error instanceof InventoryViewChanged)) {
          // The platform may reject stale stock during host selection too.
          if (!(await ledger.getPending()) && visibleMessages().some(message => core.definiteStockFailure(message))) {
            return countdownAndReload(id, settings, '平台提示库存已变化，刷新后重新选择');
          }
          throw error;
        }
        // Never restart a task across an uncertain paid submission boundary.
        if (await ledger.getPending()) throw error;
        assertRunning(id);
        status('地区或显卡列表已更新，重新读取当前型号和库存…');
      }
    }
    return countdownAndReload(id, settings, '地区或显卡列表连续更新，稍后重试');
  }

  async function acquireAndRun(settings, newStart, checkOnly = false) {
    if (working || (!newStart && !running())) return;
    if (!navigator.locks) return stop('当前浏览器不支持防重复锁，停止运行。');
    working = true;
    syncControls();
    const id = ++serial;
    try {
      await navigator.locks.request(LOCK_NAME, { mode: 'exclusive', ifAvailable: true }, async lock => {
        if (!lock) return stop('另一个标签页正在运行同一抢机任务。');
        if (await ledger.getPending()) return stop('存在未核实的提交。请先检查实例列表，再决定是否重置。');
        if (newStart) {
          await storage.set({ [SETTINGS_KEY]: settings, [ACTIVE_KEY]: settings });
          if (id !== serial) return;
          sessionStorage.setItem(RUN_KEY, checkOnly ? 'check' : '1');
          syncControls();
        }
        await monitor(id, settings);
      });
    } catch (error) {
      if (running() || newStart) {
        let hasPending = true;
        try { hasPending = !!(await ledger.getPending()); } catch (_) {}
        await stop((hasPending ? '提交状态待核实：' : '已停止：') + String(error.message || error));
      }
    } finally { working = false; syncControls(); }
  }

  saveButton.addEventListener('click', async () => {
    if (busy || working || running()) return;
    busy = true; syncControls();
    try {
      const settings = readFields();
      await storage.set({ [SETTINGS_KEY]: settings });
      status('设置已保存；点击开始后生效。');
    } catch (error) { status('设置未保存：' + String(error.message || error)); }
    finally { busy = false; syncControls(); }
  });

  async function startTask(checkOnly) {
    if (busy || working || running()) return;
    busy = true; syncControls();
    let settings;
    try {
      if (await ledger.getPending()) return status('存在未核实的提交，先检查实例列表，再点击重置。');
      verifyUrl();
      settings = readFields();
      const message = '开始监控并在符合条件时自动创建并开机？\n' +
        '单卡显存≥' + settings.minVramGB + 'GB；主机可扩容≥' + settings.minExpandableGB + 'GB；实际扩容' + settings.expandGB + 'GB。\n' +
        '单卡≤' + settings.maxHourlyCny + '元/时；CUDA≥' + settings.minCudaMajor + '.' + settings.minCudaMinor + '；每轮后' + settings.refreshSeconds + '秒刷新。\n' +
        '按量计费，数据盘另行计费；本链接不复制旧数据盘。';
      if (!checkOnly && !confirm('源实例：' + SOURCE_ID + '\n' + message)) return;
      status(checkOnly ? '仅检查已启动；本轮不会创建实例。' : '已启动；请保持本标签页和浏览器打开。');
    } catch (error) { status('无法启动：' + String(error.message || error)); return; }
    finally { busy = false; syncControls(); }
    void acquireAndRun(settings, true, checkOnly);
  }
  startButton.addEventListener('click', () => { void startTask(false); });
  checkButton.addEventListener('click', () => { void startTask(true); });
  stopButton.addEventListener('click', () => { void stop('已停止监控。已有提交不会撤销。'); });
  resetButton.addEventListener('click', async () => {
    if (busy || working || running()) return;
    busy = true; syncControls();
    try {
      if (!(await ledger.getPending())) return status('没有待核实的提交。');
      if (!confirm('请先在 AutoDL 实例列表确认没有刚才创建的新实例。\n只有确认后才能清除记录并允许再次抢机，确定清除吗？')) return;
      await ledger.clearPending();
      await stop('提交记录已清除；可重新点击开始。');
    } catch (error) { status('无法重置提交记录：' + String(error.message || error)); }
    finally { busy = false; syncControls(); }
  });

  async function initialize() {
    syncControls();
    try {
      const stored = await storage.get([SETTINGS_KEY, ACTIVE_KEY]);
      const saved = stored[SETTINGS_KEY] ? core.validateSettings(stored[SETTINGS_KEY]) : core.LIMITS;
      setFields(saved);
      if (await ledger.getPending()) {
        sessionStorage.removeItem(RUN_KEY);
        status('存在未核实的提交。请先检查实例列表；确认后可重置。');
      } else if (checkingOnly()) {
        sessionStorage.removeItem(RUN_KEY);
        await storage.remove(ACTIVE_KEY);
        status('上次仅检查已中断；可重新点击仅检查，不会自动创建实例。');
      } else if (running()) {
        if (!stored[ACTIVE_KEY]) {
          sessionStorage.removeItem(RUN_KEY);
          status('原运行配置缺失，请检查设置后重新启动。');
        } else {
          const active = core.validateSettings(stored[ACTIVE_KEY]);
          setFields(active);
          busy = false; syncControls();
          status('刷新后按原配置恢复监控。');
          void acquireAndRun(active, false);
          return;
        }
      } else status('设置就绪，可修改后点击开始。');
    } catch (error) {
      sessionStorage.removeItem(RUN_KEY);
      status('读取设置失败：' + String(error.message || error));
    }
    busy = false; syncControls();
  }
  void initialize();
})();
