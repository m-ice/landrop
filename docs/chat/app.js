(() => {
  'use strict';

  const $ = id => document.getElementById(id);
  const Peer = window.LanChatPeer;
  const Room = window.LanChatRoom;
  const served = /^(https?):$/.test(location.protocol);
  const automatic = served && Boolean(document.querySelector('meta[name="landrop-chat-signaling"][content="lan"]'));
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
  const pageUrl = 'https://m-ice.github.io/landrop/chat/';
  const phone = /Android|iPhone|iPad|Mobi/i.test(navigator.userAgent);
  const defaultName = phone ? '我的手机' : '我的电脑';
  const groupName = phone ? '手机' : '电脑';
  const panels = {
    setup: 'setupPanel', invite: 'invitePanel', host: 'hostPanel', review: 'reviewPanel',
    request: 'requestPanel', pending: 'pendingPanel', handoff: 'handoffPanel', connection: 'connectionPanel'
  };
  const statusNames = {
    idle: '未连接', waiting: '等待确认', connecting: '连接中', connected: '已连接',
    disconnected: '连接中断', closed: '已断开', failed: '连接失败'
  };
  const timeFormat = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
  const images = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/bmp']);
  const videos = new Set(['video/mp4', 'video/webm', 'video/ogg', 'video/quicktime']);
  const retainedUrls = new Set();
  const receiving = new Map();
  const pendingProgress = new Map();
  const attachments = [];
  let stage = 'setup';
  let status = 'idle';
  let statusMessage = '';
  let peer = null;
  let historyPeer = null;
  let offer = null;
  let answer = null;
  let hostInbox = null;
  let handoffState = '';
  let cameraScan = null;
  let qrFileMode = null;
  let shareToken = '';
  let shareQr = null;
  let room = null;
  let group = null;
  let groupHost = false;
  let localGroupName = '';
  let groupRequests = [];
  let busy = false;
  let fileSendingPeer = null;
  let progressFrame = null;

  function element(tag, className, value) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (value !== undefined) node.textContent = value;
    return node;
  }

  function icon(name) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'icon');
    svg.setAttribute('aria-hidden', 'true');
    const use = document.createElementNS(svg.namespaceURI, 'use');
    use.setAttribute('href', `#i-${name}`);
    svg.append(use);
    return svg;
  }

  function announce(text = '', error = false, target = $('notice')) {
    target.textContent = text;
    target.dataset.error = String(error);
    target.hidden = !text;
  }

  function updateComposer() {
    const connected = Boolean(peer?.connected);
    const sendingFiles = connected && fileSendingPeer === peer;
    $('attachButton').disabled = !connected || sendingFiles;
    $('messageInput').disabled = !connected;
    $('sendButton').disabled = !connected || (!attachments.length && !$('messageInput').value.trim());
    $('messageInput').placeholder = connected ? '输入消息' : '连接设备后可发送';
  }

  function render() {
    for (const [name, id] of Object.entries(panels)) $(id).hidden = stage !== name;
    const hostControls = groupHost && Boolean(room) && !['closed', 'failed'].includes(status);
    $('hostPanel').hidden = stage !== 'host' && !hostControls;
    const guestRosterOnly = Boolean(group && !groupHost && status === 'connected');
    if (guestRosterOnly) $('connectionPanel').hidden = true;
    $('membersPanel').classList.toggle('separated', !guestRosterOnly);
    $('reviewPanel').hidden = stage !== 'review' && (!hostControls || !groupRequests.length);
    $('reviewPanel').classList.toggle('separated', hostControls);
    $('groupRequestCount').hidden = !hostControls || groupRequests.length < 2;
    if (groupRequests.length) {
      $('requesterName').textContent = groupRequests[0].name;
      $('groupRequestCount').textContent = groupRequests.length > 1 ? `另有 ${groupRequests.length - 1} 份申请。` : '';
    }
    $('pageDescription').textContent = automatic ? '在同一个 Wi-Fi 或局域网内，群聊并互发文字、照片、视频和文件。' : '在同一个 Wi-Fi 或局域网内，一对一发送文字、照片、视频和文件。';
    $('manualJoinControls').hidden = automatic;
    $('lanHostHint').hidden = automatic || !served;
    $('joiningDevice').hidden = !group;
    $('joiningDevice').textContent = localGroupName ? `我的设备 ${localGroupName}` : '';
    $('answerReceiver').hidden = automatic;
    $('setupHint').textContent = automatic ? '创建会话并分享链接或二维码，收到申请后点同意。每个会话最多 6 台设备。' : '当前为一对一配对。创建后，请把邀请链接或二维码发给对方。';
    $('joinHint').textContent = room ? '点击申请加入，等待对方确认。' : '申请后，请把二维码展示给创建方。';
    $('hostHint').textContent = room
      ? '请对方扫描二维码或打开邀请链接，申请会出现在此处。'
      : '请对方打开邀请并点申请加入。扫描对方的申请二维码，或读取对方发来的二维码图片。';
    $('handoffHint').textContent = {
      checking: '正在查找创建会话的标签页…',
      delivered: '申请已转交，请回到创建会话的标签页点击同意。',
      failed: '未找到等待申请的标签页。请在创建会话的浏览器打开此链接，或回到原页面扫描申请二维码。'
    }[handoffState] || '';
    $('handoffButton').hidden = handoffState !== 'failed';
    $('copyHandoffButton').hidden = handoffState !== 'failed';
    $('pendingHint').textContent = statusMessage.startsWith('暂时无法') ? statusMessage + ' 请保持本页打开，网页会重试连接。' : '加入申请已发出。请保持本页打开，同意后会自动连接。';
    const reset = $('resetButton');
    reset.hidden = stage === 'setup';
    reset.disabled = busy;
    reset.textContent = hostControls ? '结束会话' : group?.connected ? '退出会话' : status === 'connected' ? '断开连接' : '返回连接选项';
    for (const id of ['createButton', 'requestButton', 'approveButton', 'rejectButton', 'handoffButton']) $(id).disabled = busy || !Peer || !window.RTCPeerConnection || (automatic && !Room);
    for (const id of ['scanInviteButton', 'pickInviteImageButton', 'scanAnswerButton', 'pickAnswerImageButton']) {
      $(id).disabled = busy || !Peer || !window.RTCPeerConnection;
    }
    $('connectionStatus').dataset.state = status;
    const label = hostControls && status === 'waiting' ? '等待加入' : statusNames[status];
    if ($('connectionLabel').textContent !== label) $('connectionLabel').textContent = label;
    const memberCount = renderMembers();
    const currentName = group && memberCount ? `${memberCount} 台设备已连接` : peer?.remoteName;
    if (status === 'connected') {
      $('threadSubtitle').textContent = currentName || '对方设备';
      $('emptyTitle').textContent = '会话已建立';
      $('emptyHint').textContent = '发条消息，或选择要分享的附件。';
    } else {
      $('threadSubtitle').textContent = currentName || '连接另一台设备后开始聊天';
      $('emptyTitle').textContent = stage === 'setup' || (hostControls && status === 'waiting') ? '等待设备加入' : label;
      $('emptyHint').textContent = stage === 'setup' ? '创建会话或打开对方的邀请，建立连接后即可发送消息和附件。' : '请保持发起方和加入方的页面打开。';
    }
    $('connectedName').textContent = currentName || statusNames[status];
    $('connectionHint').textContent = statusMessage;
    updateComposer();
  }

  function renderMembers() {
    const members = group?.members || [];
    const online = members.filter(member => member.connected).length;
    $('membersPanel').hidden = !members.length && !(groupHost && room && !['closed', 'failed'].includes(status));
    $('membersTitle').textContent = `会话成员（${members.length + 1}）`;
    const ownName = element('li', 'member-name', localGroupName ? `${localGroupName}（我）` : '我');
    const rows = members.map(member => {
      const row = element('li');
      const label = member.connected ? '已连接' : member.failed ? '未连接' : '连接中';
      row.append(element('span', 'member-name', member.name), element('span', 'member-status', label));
      return row;
    });
    $('memberList').replaceChildren(ownName, ...rows);
    return online;
  }

  function inputToken(input, key) {
    const value = input.trim();
    if (value.startsWith('LC1.')) return value;
    try {
      const url = new URL(value);
      const candidate = new URLSearchParams(url.hash.slice(1)).get(key);
      if (candidate?.startsWith('LC1.')) return candidate;
    } catch { /* Fall through to the field message. */ }
    throw new Error(key === 'invite' ? '请读取邻传的邀请二维码。' : '请读取邻传的申请二维码。');
  }

  function shareUrl(key, token) {
    const origin = key === 'room' ? $('shareAddress').value : '';
    const url = origin ? new URL(location.pathname, origin) : new URL(served ? location.href : pageUrl);
    url.hash = new URLSearchParams({ [key]: token }).toString();
    return url.href;
  }

  function paintQr(content) {
    const qr = new window.LocalQRCode(-1, 1);
    qr.addData(content);
    qr.make();
    shareQr = qr;
    drawQr();
  }

  function drawQr() {
    if (!shareQr || !$('shareDialog').open) return;
    const canvas = $('qrCanvas');
    const n = shareQr.getModuleCount();
    const margin = 4;
    const dpr = window.devicePixelRatio || 1;
    const available = Math.min(canvas.parentElement.clientWidth, 360);
    const scale = Math.max(1, Math.floor(available * dpr / (n + 2 * margin)));
    canvas.width = canvas.height = (n + 2 * margin) * scale;
    canvas.style.width = `${canvas.width / dpr}px`;
    const context = canvas.getContext('2d');
    context.fillStyle = '#fff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = '#10291f';
    for (let row = 0; row < n; row++) {
      for (let col = 0; col < n; col++) {
        if (shareQr.isDark(row, col)) context.fillRect((col + margin) * scale, (row + margin) * scale, scale, scale);
      }
    }
    canvas.hidden = false;
  }

  function openShare(key, token) {
    shareToken = token;
    const roomInvite = key === 'room';
    const invitation = key !== 'answer';
    const origins = roomInvite && loopback ? room.joinOrigins : [];
    const address = $('shareAddress');
    const existingOrigin = address.value;
    address.replaceChildren(...origins.map(origin => {
      const option = element('option', '', origin);
      option.value = origin;
      return option;
    }));
    if (origins.includes(existingOrigin)) address.value = existingOrigin;
    $('shareAddressField').hidden = origins.length < 2;
    $('shareTitle').textContent = invitation ? '分享邀请' : '分享加入申请';
    const instructions = roomInvite ? '请对方扫码或打开链接，点申请加入。收到申请后，你可以同意或拒绝。' :
      invitation ? '用另一台设备扫描二维码或打开链接。' : '请创建方在原页面扫描此二维码，或用同一个浏览器打开此链接。';
    const offlineHint = !served ? '无外网时，请在对方已打开的邻传页面读取二维码。' : '';
    let loopbackHint = '';
    if (loopback && !origins.length) {
      loopbackHint = roomInvite ? '当前只能生成本机地址。请确认主机已连接局域网，并允许其他设备访问邻传。' :
        '本机地址在另一台设备上无法打开。请在对方已打开的邻传页面读取二维码。';
    }
    $('shareHint').textContent = instructions + offlineHint + loopbackHint;
    if (!$('shareDialog').open) $('shareDialog').showModal();
    updateShareCode(key, token);
  }

  function updateShareCode(key, token) {
    shareQr = null;
    const url = shareUrl(key, token);
    $('shareLink').value = url;
    $('qrCanvas').setAttribute('aria-label', key === 'answer' ? '申请链接二维码' : '邀请链接二维码');
    $('qrCanvas').hidden = true;
    $('saveQrButton').hidden = true;
    $('qrHint').hidden = true;
    announce('', false, $('shareStatus'));
    try { paintQr(url); } catch {
      if (key === 'room') {
        $('qrHint').textContent = '无法生成二维码，请复制邀请链接。';
        $('qrHint').hidden = false;
        return;
      }
      try {
        paintQr(token);
        $('qrHint').textContent = '请在邻传聊天中读取此二维码。';
      } catch {
        shareQr = null;
        $('qrHint').textContent = '无法生成二维码，请复制链接。';
      }
      $('qrHint').hidden = false;
    }
    $('saveQrButton').hidden = $('qrCanvas').hidden;
  }

  function saveQrImage() {
    const canvas = $('qrCanvas');
    if (canvas.hidden) return;
    const link = element('a');
    link.download = $('shareTitle').textContent === '分享加入申请' ? '邻传申请二维码.png' : '邻传邀请二维码.png';
    link.href = canvas.toDataURL('image/png');
    link.click();
  }

  async function copy(value, target = $('notice')) {
    try {
      await navigator.clipboard.writeText(value);
      announce('已复制。', false, target);
      return;
    } catch { /* The page may run from a file or an HTTP LAN address. */ }
    const field = element('textarea', 'copy-field');
    field.value = value;
    field.readOnly = true;
    const priorFocus = document.activeElement;
    (target.closest('dialog') || document.body).append(field);
    field.select();
    try {
      if (document.execCommand('copy')) {
        announce('已复制。', false, target);
        field.remove();
        priorFocus?.focus();
        return;
      }
    } catch { /* Offer the selected value for manual copy. */ }
    field.classList.add('manual-copy');
    field.setAttribute('aria-label', '请手动复制以下内容');
    field.focus();
    field.select();
    field.addEventListener('blur', () => field.remove(), { once: true });
    announce('请手动复制选中的内容。', true, target);
  }

  async function task(action, pending = '') {
    if (busy) return;
    const originalStage = stage;
    busy = true;
    announce(pending);
    render();
    try { await action(); } catch (error) { announce(error.message || '操作失败，请重试。', true); }
    finally {
      busy = false;
      render();
      const nextControl = { invite: 'requestButton', review: 'approveButton', handoff: 'handoffHeading' }[stage];
      if (nextControl && stage !== originalStage && !$('shareDialog').open) $(nextControl).focus();
    }
  }

  function closeInbox() {
    hostInbox?.close();
    hostInbox = null;
  }

  function closePeer() {
    const previous = peer;
    peer = null;
    group = room = null;
    groupHost = false;
    localGroupName = '';
    groupRequests = [];
    previous?.close();
    closeInbox();
  }

  function reset() {
    if (busy) return;
    const wasConnected = Boolean(peer?.connected) || status === 'disconnected';
    failReceives('接收中断，请让对方重新发送。');
    closePeer();
    offer = answer = null;
    handoffState = '';
    status = wasConnected ? 'closed' : 'idle';
    stage = 'setup';
    statusMessage = '';
    if ($('shareDialog').open) $('shareDialog').close();
    closeScanner();
    $('messageInput').value = '';
    attachments.length = 0;
    renderAttachments();
    announce(wasConnected ? '连接已断开。' : '');
    render();
  }

  function clearHistory() {
    pendingProgress.clear();
    for (const url of retainedUrls) URL.revokeObjectURL(url);
    retainedUrls.clear();
    receiving.clear();
    $('messages').replaceChildren();
    $('messages').hidden = true;
    $('emptyThread').hidden = false;
  }

  function bindPeer(name) {
    return bindSession(new Peer(name));
  }

  function bindGroup(host, name) {
    if (!name) {
      const suffix = crypto.getRandomValues(new Uint16Array(1))[0].toString(16).padStart(4, '0').toUpperCase();
      name = `${groupName} · ${suffix}`;
    }
    localGroupName = name;
    const session = new Room(localGroupName);
    group = session;
    groupHost = host;
    session.addEventListener('requests', ({ detail }) => {
      if (group !== session) return;
      const first = groupRequests[0]?.id;
      groupRequests = detail.requests;
      const next = groupRequests[0]?.id;
      if (next && next !== first && $('shareDialog').open) $('shareDialog').close();
      render();
      if (next && next !== first && !busy) $('approveButton').focus();
    });
    return bindSession(session);
  }

  function bindSession(session) {
    peer = session;
    session.addEventListener('statechange', ({ detail }) => {
      if (peer !== session) return;
      let revealComposer = false;
      status = detail.state;
      statusMessage = detail.message;
      stage = 'connection';
      if (group === session) {
        if (status === 'rejected') {
          const rejectedRoom = room;
          const name = localGroupName;
          closePeer();
          bindGroup(false, name);
          room = rejectedRoom;
          status = 'idle';
          stage = 'invite';
          announce(statusMessage || '发起方拒绝了加入申请。你可以再次申请。', true);
          render();
          if (!busy) $('requestButton').focus();
          return;
        }
        if (groupHost && !['closed', 'failed'].includes(status)) stage = 'host';
        else if (status === 'waiting') stage = 'pending';
      }
      if (status === 'connected') {
        closeInbox();
        if (historyPeer !== session) {
          clearHistory();
          historyPeer = session;
          revealComposer = !groupHost && matchMedia('(max-width: 740px)').matches;
        }
        if (!groupHost && $('shareDialog').open) $('shareDialog').close();
        announce();
      } else if (['closed', 'disconnected', 'failed'].includes(status)) {
        closeInbox();
        failReceives('接收中断，请让对方重新发送。');
        if ($('shareDialog').open) $('shareDialog').close();
        announce();
      } else if (group && (status === 'waiting' || status === 'connecting')) {
        announce();
      }
      render();
      if (revealComposer) $('composer').scrollIntoView({ block: 'nearest' });
    });
    session.addEventListener('text', ({ detail }) => {
      if (peer === session) addMessage(false, detail.text, detail.from);
    });
    session.addEventListener('fileprogress', ({ detail }) => {
      if (peer !== session) return;
      const entry = entryForFile(detail);
      updateProgress(entry, detail.received, detail.size, '接收中');
    });
    session.addEventListener('file', ({ detail }) => {
      if (peer !== session) return;
      const entry = entryForFile(detail);
      finishFile(entry, detail.blob, detail.name, detail.type);
      receiving.delete(detail.id);
    });
    session.addEventListener('transfererror', ({ detail }) => {
      if (peer !== session) return;
      const entry = receiving.get(detail.id);
      if (entry) setDelivery(entry, detail.message, true);
      else announce(detail.message, true);
      receiving.delete(detail.id);
    });
    return session;
  }

  async function read(input, expected) {
    const key = expected === 'invite' ? 'invite' : 'answer';
    const token = inputToken(input, key);
    const info = await Peer.readToken(token);
    if (info.kind !== expected) throw new Error(expected === 'invite' ? '这是加入申请，请交给会话创建方。' : '这是邀请二维码，请扫描对方的申请二维码。');
    return { token, info };
  }

  async function inspectOffer(input, stillOpen = () => true) {
    const pending = await read(input, 'invite');
    if (!stillOpen()) return;
    offer = pending;
    closeScanner();
    showOffer();
    if (!busy) $('requestButton').focus();
  }

  async function openRoom(id) {
    if (!automatic) throw new Error('请在提供邀请的邻传局域网网页中打开此链接。');
    if (!/^[A-Za-z0-9_-]{24}$/.test(id)) throw new Error('会话邀请无效，请获取新的邀请链接。');
    closePeer();
    const current = bindGroup(false);
    try {
      const result = await current.inspect(id);
      room = { id };
      $('inviterName').textContent = result.hostName;
      stage = 'invite';
      status = 'idle';
      render();
    } catch (error) {
      closePeer();
      stage = 'setup';
      status = 'idle';
      throw error;
    }
  }

  function showOffer() {
    $('inviterName').textContent = offer.info.name;
    stage = 'invite';
    render();
  }

  async function createInvite() {
    const session = automatic ? bindGroup(true) : bindPeer(defaultName);
    try {
      if (automatic) {
        const created = await session.create();
        room = { id: created.room, joinOrigins: created.joinOrigins };
      } else {
        offer = { token: await session.createInvite() };
        listenForAnswers(session.sessionId);
      }
      stage = 'host';
      status = 'waiting';
      statusMessage = '';
      announce();
      render();
      if (room) openShare('room', room.id);
      else openShare('invite', offer.token);
    } catch (error) {
      closePeer();
      stage = 'setup';
      status = 'idle';
      throw error;
    }
  }

  async function createRequest() {
    if (group) {
      await group.apply(room.id);
      return;
    }
    const session = bindPeer(defaultName);
    try {
      const token = await session.createRequest(offer.token);
      answer = { token };
      stage = 'request';
      status = 'waiting';
      statusMessage = '';
      announce();
      render();
      openShare('answer', token);
    } catch (error) {
      closePeer();
      stage = 'invite';
      status = 'idle';
      throw error;
    }
  }

  async function inspectAnswer(input, stillOpen = () => true) {
    const pending = await read(input, 'request');
    if (!stillOpen()) return;
    if (!peer || stage !== 'host' || pending.info.sessionId !== peer.sessionId) throw new Error('这份加入申请不属于当前会话。请回到生成邀请的页面。');
    answer = pending;
    closeScanner();
    if ($('shareDialog').open) $('shareDialog').close();
    $('requesterName').textContent = answer.info.name;
    stage = 'review';
    render();
    if (!busy) $('approveButton').focus();
  }

  function canReadQr(mode) {
    return !automatic && (mode === 'invite' ? stage === 'setup' : mode === 'request' && stage === 'host' && peer && !room);
  }

  function acceptQr(mode, value, stillOpen) {
    return mode === 'invite' ? inspectOffer(value, stillOpen) : inspectAnswer(value, stillOpen);
  }

  function stopCameraScan() {
    if (!cameraScan) return;
    clearTimeout(cameraScan.timer);
    cameraScan.stream?.getTracks().forEach(track => track.stop());
    cameraScan = null;
    const video = $('answerScanVideo');
    video.srcObject = null;
    video.hidden = true;
  }

  function closeScanner() {
    stopCameraScan();
    if ($('answerScanDialog').open) $('answerScanDialog').close();
  }

  async function scanCameraFrame(scan) {
    const active = () => cameraScan === scan && $('answerScanDialog').open && canReadQr(scan.mode);
    if (!active()) return;
    try {
      const value = await window.readLanChatQr($('answerScanVideo'));
      if (active() && value && value !== scan.lastValue) {
        scan.lastValue = value;
        await acceptQr(scan.mode, value, active);
      } else if (!value) {
        scan.lastValue = '';
      }
    } catch (error) {
      if (active()) $('answerScanHint').textContent = error.message || '未能读取二维码，请对准二维码重试。';
    }
    if (active()) scan.timer = setTimeout(() => { void scanCameraFrame(scan); }, 240);
  }

  async function openScanner(mode) {
    if (busy || !canReadQr(mode) || $('answerScanDialog').open) return;
    const scan = { mode, stream: null, timer: null, lastValue: '' };
    cameraScan = scan;
    $('answerScanTitle').textContent = mode === 'invite' ? '扫描邀请二维码' : '扫描申请二维码';
    $('answerScanHint').textContent = '正在打开摄像头…';
    $('answerScanDialog').showModal();
    try {
      if (!navigator.mediaDevices?.getUserMedia || typeof window.readLanChatQr !== 'function') {
        throw new Error('摄像头不可用');
      }
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 960 }, height: { ideal: 720 } },
        audio: false
      });
      if (cameraScan !== scan || !$('answerScanDialog').open) {
        stream.getTracks().forEach(track => track.stop());
        return;
      }
      scan.stream = stream;
      const video = $('answerScanVideo');
      video.srcObject = stream;
      video.hidden = false;
      await video.play();
      if (cameraScan !== scan) return;
      $('answerScanHint').textContent = '将二维码完整放入画面。';
      void scanCameraFrame(scan);
    } catch {
      if (cameraScan !== scan) return;
      scan.stream?.getTracks().forEach(track => track.stop());
      const video = $('answerScanVideo');
      video.srcObject = null;
      video.hidden = true;
      $('answerScanHint').textContent = '无法使用摄像头。请选择对方发来的二维码图片。';
    }
  }

  function pickQrImage(mode) {
    if (busy || !canReadQr(mode)) return;
    closeScanner();
    qrFileMode = mode;
    $('answerQrFile').click();
  }

  function answerChannel(sessionId) {
    return new BroadcastChannel(`landrop-chat:${sessionId}`);
  }

  function listenForAnswers(sessionId) {
    try { hostInbox = answerChannel(sessionId); } catch { return; }
    const inbox = hostInbox;
    inbox.addEventListener('message', ({ data }) => {
      if (data?.kind !== 'join-request' || typeof data.id !== 'string' || typeof data.token !== 'string') return;
      if (stage === 'review' && answer?.token === data.token) {
        inbox.postMessage({ kind: 'request-received', id: data.id });
        return;
      }
      if (stage !== 'host') return;
      inspectAnswer(data.token).then(() => {
        if (hostInbox === inbox) inbox.postMessage({ kind: 'request-received', id: data.id });
      }).catch(() => {});
    });
  }

  async function handOffAnswer() {
    handoffState = 'checking';
    render();
    let channel;
    try {
      const { token, info } = answer;
      channel = answerChannel(info.sessionId);
      const id = Array.from(crypto.getRandomValues(new Uint32Array(3)), value => value.toString(16)).join('-');
      const delivered = await new Promise(resolve => {
        const timer = setTimeout(() => resolve(false), 4000);
        channel.addEventListener('message', ({ data }) => {
          if (data?.kind !== 'request-received' || data.id !== id) return;
          clearTimeout(timer);
          resolve(true);
        });
        try { channel.postMessage({ kind: 'join-request', id, token }); }
        catch { clearTimeout(timer); resolve(false); }
      });
      handoffState = delivered ? 'delivered' : 'failed';
    } catch {
      handoffState = 'failed';
    } finally {
      channel?.close();
    }
  }

  async function approve() {
    if (group) { await decideGroupRequest('approved'); return; }
    try { await peer.approveRequest(answer.token); }
    catch (error) {
      closePeer();
      stage = 'connection';
      status = 'failed';
      statusMessage = '无法应用这份申请，请新建会话后重试。';
      throw error;
    }
  }

  async function reject() {
    if (group) { await decideGroupRequest('rejected'); return; }
    answer = null;
    stage = 'host';
    announce('已拒绝本次申请。你仍可查看其他设备的申请。');
    render();
    $('showInviteButton').focus();
  }

  async function decideGroupRequest(decision) {
    const request = groupRequests[0];
    if (!request) return;
    await group.decide(request.id, decision);
    groupRequests = groupRequests.filter(item => item.id !== request.id);
    announce(decision === 'approved' ? '' : '已拒绝本次申请。');
  }

  function readableSize(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
  }

  function followThread() {
    const area = $('messageViewport');
    const atBottom = area.scrollHeight - area.clientHeight - area.scrollTop < 80;
    return () => { if (atBottom) area.scrollTop = area.scrollHeight; };
  }

  function addMessage(sent, text = '', from) {
    const follow = followThread();
    const row = element('li', sent ? 'message sent' : 'message');
    const meta = element('div', 'message-meta');
    const time = element('time', '', timeFormat.format(new Date()));
    time.dateTime = new Date().toISOString();
    meta.append(element('span', '', sent ? '我' : from || peer?.remoteName || '对方设备'), time);
    const body = element('div', 'message-body');
    const delivery = element('p', 'message-state');
    delivery.hidden = true;
    if (text) body.append(element('p', 'message-text', text));
    row.append(meta, body, delivery);
    $('messages').append(row);
    $('messages').hidden = false;
    $('emptyThread').hidden = true;
    follow();
    return { body, delivery };
  }

  function setDelivery(entry, title, error = false) {
    const follow = followThread();
    pendingProgress.delete(entry);
    entry.progress?.remove();
    entry.delivery.dataset.error = String(error);
    entry.delivery.textContent = title;
    entry.delivery.hidden = !title;
    follow();
  }

  function addFile(sent, name, size, from) {
    const follow = followThread();
    const entry = addMessage(sent, '', from);
    const file = element('div', 'message-file');
    const title = element('div');
    title.append(element('strong', '', name), element('span', 'file-size', readableSize(size)));
    file.append(icon('file'), title);
    entry.body.append(file);
    entry.progress = element('progress');
    entry.progress.setAttribute('aria-label', sent ? '发送进度' : '接收进度');
    follow();
    return entry;
  }

  function entryForFile(detail) {
    let entry = receiving.get(detail.id);
    if (!entry) {
      entry = addFile(false, detail.name, detail.size, detail.from);
      receiving.set(detail.id, entry);
    }
    return entry;
  }

  function updateProgress(entry, current, total, label) {
    pendingProgress.set(entry, { current, total, label });
    if (progressFrame !== null) return;
    // Several channels may report progress between paints. Update the thread once.
    progressFrame = requestAnimationFrame(() => {
      progressFrame = null;
      if (!pendingProgress.size) return;
      const follow = followThread();
      for (const [entry, { current, total, label }] of pendingProgress) {
        if (!entry.body.isConnected) continue;
        if (!entry.progress.isConnected) entry.body.append(entry.progress);
        entry.progress.max = total || 1;
        entry.progress.value = total ? current : 1;
        const text = `${label} · ${total ? Math.floor(current / total * 100) : 100}%`;
        if (entry.delivery.textContent !== text) entry.delivery.textContent = text;
        entry.delivery.hidden = false;
      }
      pendingProgress.clear();
      follow();
    });
  }

  function finishFile(entry, blob, name, type) {
    const follow = followThread();
    const preview = images.has(type) || videos.has(type);
    const url = URL.createObjectURL(preview ? blob : blob.slice(0, blob.size, 'application/octet-stream'));
    retainedUrls.add(url);
    if (images.has(type)) {
      const image = element('img');
      image.alt = name;
      image.src = url;
      image.addEventListener('load', follow, { once: true });
      image.addEventListener('error', () => image.remove(), { once: true });
      entry.body.prepend(image);
    } else if (videos.has(type)) {
      const video = element('video');
      video.controls = true;
      video.playsInline = true;
      video.preload = 'metadata';
      video.setAttribute('aria-label', name);
      video.addEventListener('loadedmetadata', follow, { once: true });
      video.addEventListener('error', () => video.remove(), { once: true });
      video.src = url;
      entry.body.prepend(video);
    }
    const link = element('a', 'download', '下载');
    link.href = url;
    link.download = name.replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, '_');
    link.setAttribute('aria-label', `下载 ${name}`);
    link.prepend(icon('download'));
    entry.body.append(link);
    setDelivery(entry, '');
    follow();
  }

  function failReceives(message) {
    for (const entry of receiving.values()) setDelivery(entry, message, true);
    receiving.clear();
  }

  function renderAttachments() {
    const items = attachments.map((file, index) => {
      const row = element('li');
      const name = element('span', '', file.name);
      name.title = file.name;
      const remove = element('button', 'button secondary icon-button');
      remove.type = 'button';
      remove.setAttribute('aria-label', `移除 ${file.name}`);
      remove.append(icon('close'));
      remove.addEventListener('click', () => {
        attachments.splice(index, 1);
        renderAttachments();
        $('attachButton').focus();
      });
      row.append(name, remove);
      return row;
    });
    $('attachments').replaceChildren(...items);
    $('attachments').hidden = attachments.length === 0;
    updateComposer();
  }

  function stageFiles(files) {
    if (!peer?.connected || fileSendingPeer === peer) return;
    let skipped = false;
    for (const file of files) {
      if (file.size > Peer.MAX_FILE_BYTES || attachments.length >= 12) skipped = true;
      else attachments.push(file);
    }
    announce(skipped ? '已略过超出 256 MiB 的文件或超过 12 个的附件。' : '', skipped);
    renderAttachments();
  }

  async function sendFiles(current, batch) {
    try {
      for (const { file, entry } of batch) {
        if (current !== peer || !current.connected) {
          setDelivery(entry, '连接已断开，请重新选择附件。', true);
          continue;
        }
        updateProgress(entry, 0, file.size, '发送中');
        try {
          await current.sendFile(file, (received, total) => updateProgress(entry, received, total, '发送中'));
          setDelivery(entry, current === group ? '在线成员已接收' : '对方已接收');
        } catch (error) { setDelivery(entry, error.message || '发送失败，请重新选择文件。', true); }
      }
    } finally {
      if (fileSendingPeer === current) fileSendingPeer = null;
      updateComposer();
    }
  }

  async function sendMessage(event) {
    event.preventDefault();
    const current = peer;
    if (!current?.connected) return;
    const text = $('messageInput').value;
    const entry = text.trim() ? addMessage(true, text) : null;
    const batch = attachments.splice(0).map(file => {
      const entry = addFile(true, file.name, file.size);
      setDelivery(entry, '等待发送');
      return { file, entry };
    });
    if (batch.length) fileSendingPeer = current;
    $('messageInput').value = '';
    renderAttachments();
    if (entry) {
      setDelivery(entry, '发送中');
      try { await current.sendText(text); setDelivery(entry, '已发送'); }
      catch (error) { setDelivery(entry, error.message || '发送失败，请重试。', true); }
    }
    if (batch.length) await sendFiles(current, batch);
  }

  $('fileTransferLink').hidden = !served;
  $('offlineButton').hidden = !served || !window.downloadLanChat;
  $('offlineButton').addEventListener('click', async () => {
    $('offlineButton').disabled = true;
    try { await window.downloadLanChat(); announce('离线网页已生成，请查看浏览器的下载。'); }
    catch { announce('无法保存离线网页，请重试。', true); }
    finally { $('offlineButton').disabled = false; }
  });
  $('createButton').addEventListener('click', () => task(createInvite, '正在生成邀请链接…'));
  $('scanInviteButton').addEventListener('click', () => openScanner('invite'));
  $('pickInviteImageButton').addEventListener('click', () => pickQrImage('invite'));
  $('scanAnswerButton').addEventListener('click', () => openScanner('request'));
  $('pickAnswerImageButton').addEventListener('click', () => pickQrImage('request'));
  $('answerScanFileButton').addEventListener('click', () => pickQrImage(cameraScan?.mode));
  $('answerScanDialog').addEventListener('close', () => {
    if (!$('answerScanDialog').open) stopCameraScan();
  });
  $('answerQrFile').addEventListener('change', event => {
    const file = event.target.files[0];
    event.target.value = '';
    const mode = qrFileMode;
    qrFileMode = null;
    if (!file || !canReadQr(mode)) return;
    task(async () => {
      const value = await window.readLanChatQr(file);
      if (!value) throw new Error('图片里没有读到二维码。请选择完整、清晰的邻传二维码。');
      await acceptQr(mode, value, () => canReadQr(mode));
    }, '正在读取二维码…');
  });
  $('requestButton').addEventListener('click', () => task(createRequest, '正在生成加入申请…'));
  $('showInviteButton').addEventListener('click', () => room ? openShare('room', room.id) : openShare('invite', offer.token));
  $('showAnswerButton').addEventListener('click', () => openShare('answer', answer.token));
  $('approveButton').addEventListener('click', () => task(approve, '正在建立连接…'));
  $('rejectButton').addEventListener('click', () => task(reject));
  $('handoffButton').addEventListener('click', () => task(handOffAnswer));
  $('copyHandoffButton').addEventListener('click', () => copy(shareUrl('answer', answer.token)));
  $('resetButton').addEventListener('click', reset);
  $('saveQrButton').addEventListener('click', saveQrImage);
  $('copyLinkButton').addEventListener('click', () => copy($('shareLink').value, $('shareStatus')));
  $('shareAddress').addEventListener('change', () => updateShareCode('room', shareToken));
  window.addEventListener('resize', drawQr);
  $('attachButton').addEventListener('click', () => $('fileInput').click());
  $('fileInput').addEventListener('change', event => {
    stageFiles(event.target.files);
    event.target.value = '';
  });
  $('messageInput').addEventListener('input', updateComposer);
  $('messageInput').addEventListener('keydown', event => {
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    if (!$('sendButton').disabled) $('composer').requestSubmit();
  });
  $('composer').addEventListener('submit', sendMessage);
  window.addEventListener('pagehide', () => { closeScanner(); closePeer(); clearHistory(); });
  window.addEventListener('pageshow', event => { if (event.persisted) reset(); });

  async function readHash() {
    const hash = new URLSearchParams(location.hash.slice(1));
    const requestToken = hash.get('answer');
    const inviteToken = hash.get('invite');
    const roomId = hash.get('room');
    if (!requestToken && !inviteToken && !roomId) return;
    const cleanUrl = new URL(location.href);
    cleanUrl.hash = '';
    try { history.replaceState(null, '', cleanUrl); } catch { /* Browser may restrict file: URLs. */ }
    await task(async () => {
      if (roomId) {
        if (stage !== 'setup' && stage !== 'invite') throw new Error('请在新标签页打开这份邀请。');
        await openRoom(roomId);
      } else if (requestToken) {
        if (stage === 'host' && !room) { await inspectAnswer(requestToken); return; }
        if (stage !== 'setup' && stage !== 'handoff') throw new Error('请先退出当前连接流程，再打开另一份加入申请。');
        answer = await read(requestToken, 'request');
        $('handoffName').textContent = answer.info.name;
        stage = 'handoff';
        await handOffAnswer();
      } else if (stage === 'setup' || stage === 'invite') {
        closePeer();
        await inspectOffer(inviteToken);
      } else throw new Error('请先退出当前连接流程，再打开另一份邀请。');
    });
  }

  render();
  if (!window.RTCPeerConnection || !Peer || (automatic && !Room)) announce('此浏览器无法启用局域网直连。请用支持 WebRTC 的浏览器打开完整网页。', true);
  else {
    window.addEventListener('hashchange', readHash);
    readHash();
  }
})();
