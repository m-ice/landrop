'use strict';

(() => {
  const TOKEN_PREFIX = 'LC1.';
  const TOKEN_LIMIT = 16000;
  const SDP_LIMIT = 10000;
  const TEXT_LIMIT = 4000;
  const FILE_LIMIT = 256 * 1024 * 1024;
  const FILE_COUNT_LIMIT = 250;
  const CHUNK_SIZE = 16 * 1024;
  const RECEIVE_BATCH = 1024 * 1024 / CHUNK_SIZE;
  const RECEIPT_INTERVAL = 256 * 1024;
  const SEND_WINDOW = 1024 * 1024;
  const STALL_TIMEOUT = 60000;
  const CHANNEL_LABEL = 'landrop-chat-v1';
  const ID_PATTERN = /^[A-Za-z0-9_-]{22}$/;
  const encoder = new TextEncoder();
  const decoder = new TextDecoder('utf-8', { fatal: true });

  function base64url(bytes) {
    return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  }

  function readBase64url(value) {
    return Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), ch => ch.charCodeAt(0));
  }

  function newId() {
    return base64url(crypto.getRandomValues(new Uint8Array(16)));
  }

  function cleanName(value, limit, fallback) {
    return value.replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, '').trim().slice(0, limit) || fallback;
  }

  function cleanFilename(value) {
    return cleanName(value, 240, '未命名文件').replace(/[\\/:*?"<>|]/g, '_').replace(/[. ]+$/g, '') || '未命名文件';
  }

  function cleanMime(value) {
    return typeof value === 'string' && value.length <= 100 &&
      /^[\w!#$&^.+-]+\/[\w!#$&^.+-]+$/.test(value) ? value.toLowerCase() : 'application/octet-stream';
  }

  function isHostCandidate(line) {
    const match = /^a=candidate:\S+ 1 (?:udp|tcp) \d+ (\S+) (\d+) typ host(?: |$)/i.exec(line);
    if (!match) return false;
    const [, address, port] = match;
    const ipv4 = /^(?:\d{1,3}\.){3}\d{1,3}$/.test(address);
    const ipv6 = address.includes(':') && /^[\da-f:.]+$/i.test(address);
    const mdns = /^[\da-z-]+\.local$/i.test(address);
    return (ipv4 || ipv6 || mdns) && Number(port) > 0 && Number(port) <= 65535 && !/ raddr /i.test(line);
  }

  function compactSdp(sdp) {
    const lines = sdp.trim().split(/\r?\n/);
    const candidates = lines.filter(isHostCandidate);
    if (!candidates.length) {
      throw new Error('浏览器没有提供局域网连接地址。请检查浏览器的本地网络设置。');
    }
    // Prefer UDP when several network adapters are exposed. Cap the QR payload.
    candidates.sort((a, b) => Number(/ tcp /i.test(a)) - Number(/ tcp /i.test(b)));
    const keep = new Set(candidates.slice(0, 8));
    return lines.filter(line => !line.startsWith('a=candidate:') || keep.has(line)).join('\n');
  }

  async function encodeToken(fields) {
    const bytes = encoder.encode(JSON.stringify(fields));
    if (typeof CompressionStream !== 'undefined') {
      const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate'));
      return TOKEN_PREFIX + 'z' + base64url(new Uint8Array(await new Response(stream).arrayBuffer()));
    }
    return TOKEN_PREFIX + 'u' + base64url(bytes);
  }

  async function unpackToken(mode, bytes) {
    if (mode === 'u') return decoder.decode(bytes);
    if (typeof DecompressionStream === 'undefined') {
      throw new Error('请换用最新版浏览器打开此邀请链接。');
    }
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'));
    const reader = stream.getReader();
    const chunks = [];
    let size = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > TOKEN_LIMIT) throw new Error('连接信息过长。');
        chunks.push(value);
      }
      return decoder.decode(await new Blob(chunks).arrayBuffer());
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }

  async function readToken(value) {
    const token = typeof value === 'string' ? value.trim() : '';
    const match = /^LC1\.([zu])([A-Za-z0-9_-]+)$/.exec(token);
    if (!match || token.length > TOKEN_LIMIT) throw new Error('连接信息无效，请复制完整链接或配对码。');
    if (match[1] === 'z' && typeof DecompressionStream === 'undefined') {
      throw new Error('请换用最新版浏览器打开此配对码。');
    }
    try {
      const fields = JSON.parse(await unpackToken(match[1], readBase64url(match[2])));
      if (!Array.isArray(fields) || fields.length !== 4) throw new Error();
      const [kind, sessionId, name, sdp] = fields;
      if (!['invite', 'request'].includes(kind) || typeof sessionId !== 'string' || !ID_PATTERN.test(sessionId) ||
          typeof name !== 'string' || name.length > 40 || typeof sdp !== 'string' || sdp.length > SDP_LIMIT) throw new Error();
      const lines = sdp.split('\n');
      const media = lines.filter(line => line.startsWith('m='));
      const candidates = lines.filter(line => line.startsWith('a=candidate:'));
      if (lines[0] !== 'v=0' || sdp.includes('\r') ||
          media.length !== 1 || !media[0].startsWith('m=application ') ||
          candidates.length === 0 || candidates.length > 8 || !candidates.every(isHostCandidate)) throw new Error();
      return {
        kind, sessionId, name: cleanName(name, 40, '对方设备'),
        sdp: { type: kind === 'invite' ? 'offer' : 'answer', sdp: lines.join('\r\n') + '\r\n' }
      };
    } catch {
      throw new Error('连接信息无效，请让对方重新生成。');
    }
  }

  function waitForIce(pc) {
    return new Promise((resolve, reject) => {
      const finish = error => {
        clearTimeout(timeout);
        pc.removeEventListener('icegatheringstatechange', check);
        pc.removeEventListener('signalingstatechange', check);
        if (error) reject(error);
        else resolve();
      };
      const check = () => {
        if (pc.signalingState === 'closed') finish(new Error('会话已关闭。'));
        else if (pc.iceGatheringState === 'complete') finish();
      };
      const timeout = setTimeout(() => finish(), 5000);
      pc.addEventListener('icegatheringstatechange', check);
      pc.addEventListener('signalingstatechange', check);
      check();
    });
  }

  class LanChatPeer extends EventTarget {
    static MAX_FILE_BYTES = FILE_LIMIT;
    static MAX_TEXT_LENGTH = TEXT_LIMIT;
    static readToken = readToken;

    #name;
    #remoteName = '';
    #sessionId = '';
    #phase = 'idle';
    #pc = null;
    #channel = null;
    #connectTimer = null;
    #disconnectTimer = null;
    #outgoing = null;
    #incoming = null;
    #receivedBytes = 0;
    #receivedCount = 0;
    #reserveIncoming;
    #waiters = new Set();

    constructor(name, { reserveIncoming } = {}) {
      super();
      this.#name = cleanName(typeof name === 'string' ? name : '', 40, '我的设备');
      this.#reserveIncoming = reserveIncoming;
    }

    get connected() {
      return this.#phase === 'connected' && this.#channel?.readyState === 'open';
    }

    get remoteName() {
      return this.#remoteName;
    }

    get sessionId() {
      return this.#sessionId;
    }

    async createInvite() {
      this.#start();
      this.#sessionId = newId();
      try {
        this.#attach(this.#pc.createDataChannel(CHANNEL_LABEL, { ordered: true }));
        await this.#pc.setLocalDescription(await this.#pc.createOffer());
        const token = await this.#createToken('invite');
        this.#phase = 'invited';
        return token;
      } catch (error) {
        this.#terminate('failed', error.message);
        throw error;
      }
    }

    async createRequest(inviteToken) {
      const invite = await readToken(inviteToken);
      if (invite.kind !== 'invite') throw new Error('请粘贴发起者的邀请链接。');
      this.#start();
      this.#sessionId = invite.sessionId;
      this.#remoteName = invite.name;
      try {
        this.#pc.addEventListener('datachannel', event => this.#attach(event.channel));
        await this.#pc.setRemoteDescription(invite.sdp);
        await this.#pc.setLocalDescription(await this.#pc.createAnswer());
        const token = await this.#createToken('request');
        this.#beginConnecting(5 * 60 * 1000, '等待发起者确认加入申请。');
        return token;
      } catch (error) {
        this.#terminate('failed', error.message);
        throw error;
      }
    }

    async approveRequest(requestToken) {
      const request = await readToken(requestToken);
      if (this.#phase !== 'invited' || request.kind !== 'request' || request.sessionId !== this.#sessionId) {
        throw new Error('这份加入申请不属于当前会话。');
      }
      this.#phase = 'approving';
      this.#remoteName = request.name;
      try {
        await this.#pc.setRemoteDescription(request.sdp);
        this.#beginConnecting(45000, '正在与对方建立局域网连接。');
      } catch (error) {
        if (this.#phase === 'approving') this.#phase = 'invited';
        throw error;
      }
    }

    close() {
      const notifyPeer = this.connected;
      if (notifyPeer) {
        try { this.#channel.send('Q'); } catch {}
      }
      this.#terminate('closed', '你已结束会话。', notifyPeer);
    }

    async sendText(text) {
      if (typeof text !== 'string' || !text.trim() || text.length > TEXT_LIMIT) {
        throw new Error(`请输入 1 至 ${TEXT_LIMIT} 个字符。`);
      }
      await this.#waitUntil(() => this.#channel.bufferedAmount < SEND_WINDOW);
      this.#channel.send('T' + text);
    }

    async sendFile(file, progress = () => {}, readChunk = (start, end) => file.slice(start, end).arrayBuffer()) {
      if (!(file instanceof Blob) || file.size > FILE_LIMIT) throw new Error('单个附件需在 256 MiB 以内。');
      if (!this.connected) throw new Error('请先连接设备。');
      if (this.#outgoing) throw new Error('请等待当前附件发送完毕。');
      const maxMessageSize = this.#pc.sctp?.maxMessageSize;
      if (maxMessageSize && maxMessageSize < Math.min(CHUNK_SIZE, file.size)) {
        throw new Error('对方浏览器的分块传输上限过小，请换用最新版浏览器。');
      }
      const transfer = {
        id: newId(), size: file.size, sent: 0, received: 0, accepted: false, done: false, error: null,
        reportProgress() {
          try { progress(this.received, this.size); } catch {}
        }
      };
      this.#outgoing = transfer;
      try {
        this.#sendControl({
          t: 'start', id: transfer.id, name: cleanFilename(file.name || '未命名文件'),
          mime: cleanMime(file.type), size: file.size
        });
        await this.#waitUntil(() => transfer.accepted, transfer);
        const hasRoom = () => this.#channel.bufferedAmount < SEND_WINDOW &&
          transfer.sent - transfer.received < SEND_WINDOW;
        while (transfer.sent < file.size) {
          await this.#waitUntil(hasRoom, transfer);
          const part = await readChunk(transfer.sent, Math.min(file.size, transfer.sent + CHUNK_SIZE));
          if (!this.connected || transfer.error) throw transfer.error || new Error('连接已断开。');
          this.#channel.send(part);
          transfer.sent += part.byteLength;
        }
        this.#sendControl({ t: 'end', id: transfer.id });
        await this.#waitUntil(() => transfer.done, transfer);
      } catch (error) {
        if (this.connected) this.#sendControl({ t: 'cancel', id: transfer.id }, true);
        throw error;
      } finally {
        this.#outgoing = null;
      }
    }

    #start() {
      if (this.#phase !== 'idle') throw new Error('请先结束当前会话。');
      if (typeof RTCPeerConnection === 'undefined') throw new Error('此浏览器不支持 WebRTC。');
      this.#pc = new RTCPeerConnection({ iceServers: [], bundlePolicy: 'max-bundle' });
      this.#phase = 'preparing';
      this.#pc.addEventListener('connectionstatechange', () => {
        const state = this.#pc.connectionState;
        if (state === 'failed') {
          this.#terminate('failed', '局域网连接失败。请确认两台设备的网络可以互通，再重新配对。');
        } else if (state === 'disconnected' && !this.#disconnectTimer) {
          this.#disconnectTimer = setTimeout(() => {
            this.#terminate('disconnected', '连接已中断，请重新配对。');
          }, 12000);
        } else if (state === 'connected') {
          clearTimeout(this.#disconnectTimer);
          this.#disconnectTimer = null;
        }
      });
    }

    async #createToken(kind) {
      await waitForIce(this.#pc);
      if (this.#phase !== 'preparing') throw new Error('会话已结束，请重新配对。');
      const sdp = compactSdp(this.#pc.localDescription.sdp);
      const token = await encodeToken([kind, this.#sessionId, this.#name, sdp]);
      if (this.#phase !== 'preparing') throw new Error('会话已结束，请重新配对。');
      return token;
    }

    #beginConnecting(timeout, message) {
      if (this.#phase === 'connected' || ['closed', 'disconnected', 'failed'].includes(this.#phase)) return;
      this.#phase = 'connecting';
      this.#connectTimer = setTimeout(() => {
        this.#terminate('failed', '等待配对超时，请重新生成连接信息。');
      }, timeout);
      this.#emit('statechange', { state: 'connecting', message });
    }

    #attach(channel) {
      if (this.#channel || channel.label !== CHANNEL_LABEL || !channel.ordered ||
          channel.maxPacketLifeTime !== null || channel.maxRetransmits !== null) {
        channel.close();
        return;
      }
      this.#channel = channel;
      channel.binaryType = 'arraybuffer';
      channel.bufferedAmountLowThreshold = SEND_WINDOW / 2;
      channel.addEventListener('bufferedamountlow', () => this.#wake());
      channel.addEventListener('open', () => {
        if (['closed', 'disconnected', 'failed'].includes(this.#phase)) return;
        clearTimeout(this.#connectTimer);
        this.#phase = 'connected';
        this.#emit('statechange', { state: 'connected', message: '局域网直连已建立。' });
      });
      channel.addEventListener('message', event => {
        if (this.connected) this.#receive(event.data);
      });
      channel.addEventListener('error', () => {
        this.#terminate('failed', '数据通道出错，请重新配对。');
      });
      channel.addEventListener('close', () => {
        this.#terminate('disconnected', '对方已退出或连接已中断。');
      });
    }

    #terminate(state, message, notifyPeer = false) {
      if (['closed', 'disconnected', 'failed'].includes(this.#phase)) return;
      this.#phase = state;
      clearTimeout(this.#connectTimer);
      clearTimeout(this.#disconnectTimer);
      if (this.#incoming) this.#abortIncoming(message, false);
      const dispose = () => {
        this.#channel?.close();
        this.#pc?.close();
      };
      // Keep the transport alive briefly so the end-of-session message can leave the buffer.
      if (notifyPeer) setTimeout(dispose, 700);
      else dispose();
      this.#wake();
      this.#emit('statechange', { state, message });
    }

    #emit(type, detail) {
      this.dispatchEvent(new CustomEvent(type, { detail }));
    }

    #wake() {
      for (const check of this.#waiters) check();
    }

    #waitUntil(condition, transfer) {
      // Arm a stall timer only when the channel or the receiver needs time to catch up.
      if (this.connected && !transfer?.error && condition()) return Promise.resolve();
      return new Promise((resolve, reject) => {
        const finish = error => {
          clearTimeout(timeout);
          this.#waiters.delete(check);
          if (error) reject(error);
          else resolve();
        };
        const check = () => {
          if (transfer?.error) finish(transfer.error);
          else if (!this.connected) finish(new Error('连接已断开。'));
          else if (condition()) finish();
        };
        const timeout = setTimeout(() => finish(new Error('传输超时，请重试。')), STALL_TIMEOUT);
        this.#waiters.add(check);
        check();
      });
    }

    #sendControl(message, ignoreFailure = false) {
      try {
        this.#channel.send('C' + JSON.stringify(message));
      } catch (error) {
        if (!ignoreFailure) throw error;
      }
    }

    #receive(value) {
      if (value instanceof ArrayBuffer) {
        this.#receiveChunk(value);
        return;
      }
      if (typeof value !== 'string') return;
      if (value === 'Q') {
        this.#terminate('disconnected', '对方已结束会话。');
        return;
      }
      if (value[0] === 'T') {
        if (value.length > TEXT_LIMIT + 1) return;
        const text = value.slice(1);
        if (text.trim()) this.#emit('text', { text });
        return;
      }
      if (value[0] !== 'C' || value.length > 2048) return;
      let msg;
      try { msg = JSON.parse(value.slice(1)); } catch { return; }
      if (!msg || typeof msg.id !== 'string' || !ID_PATTERN.test(msg.id)) return;
      if (msg.t === 'start') {
        this.#receiveOffer(msg);
      } else if (msg.t === 'end' && msg.id === this.#incoming?.id) {
        this.#finishIncoming();
      } else if (msg.t === 'cancel' && msg.id === this.#incoming?.id) {
        this.#abortIncoming('对方取消了附件发送。', false);
      } else if (msg.id === this.#outgoing?.id) {
        this.#receiveReceipt(msg);
      }
    }

    #receiveReceipt(msg) {
      const transfer = this.#outgoing;
      if (msg.t === 'accept') {
        transfer.accepted = true;
      } else if (msg.t === 'reject') {
        transfer.error = new Error(msg.reason === 'limit' ? '对方的附件接收容量不足。' : '对方未能接收此附件。');
      } else if (msg.t === 'ack' && Number.isSafeInteger(msg.bytes) &&
                 msg.bytes >= transfer.received && msg.bytes <= transfer.sent) {
        transfer.received = msg.bytes;
      } else if (msg.t === 'done' && transfer.sent === transfer.size) {
        transfer.received = transfer.size;
        transfer.done = true;
      }
      if (transfer.accepted) transfer.reportProgress();
      this.#wake();
    }

    #receiveOffer(msg) {
      if (this.#incoming || typeof msg.name !== 'string' || !Number.isSafeInteger(msg.size) || msg.size < 0) {
        this.#sendControl({ t: 'reject', id: msg.id }, true);
        return;
      }
      if (this.#receivedBytes + msg.size > FILE_LIMIT || this.#receivedCount >= FILE_COUNT_LIMIT) {
        this.#sendControl({ t: 'reject', id: msg.id, reason: 'limit' }, true);
        return;
      }
      const release = this.#reserveIncoming?.(msg.size);
      if (release === null) {
        this.#sendControl({ t: 'reject', id: msg.id, reason: 'limit' }, true);
        return;
      }
      const transfer = {
        id: msg.id, name: cleanFilename(msg.name), type: cleanMime(msg.mime), size: msg.size, release,
        received: 0, lastAck: 0, chunks: [], parts: [], lastActivity: Date.now(), timer: null
      };
      this.#incoming = transfer;
      const checkTimeout = () => {
        const remaining = STALL_TIMEOUT - (Date.now() - transfer.lastActivity);
        if (remaining > 0) transfer.timer = setTimeout(checkTimeout, remaining);
        else this.#abortIncoming('接收超时，请让对方重试。');
      };
      transfer.timer = setTimeout(checkTimeout, STALL_TIMEOUT);
      this.#sendControl({ t: 'accept', id: msg.id }, true);
      this.#reportIncoming(transfer);
    }

    #receiveChunk(chunk) {
      const transfer = this.#incoming;
      if (!transfer) return;
      const size = chunk.byteLength;
      if (!size || size !== Math.min(CHUNK_SIZE, transfer.size - transfer.received)) {
        this.#abortIncoming('附件内容与声明大小不符。');
        return;
      }
      transfer.chunks.push(chunk);
      // Group snapshots so final assembly can reuse Blob parts instead of copying every chunk at once.
      if (transfer.chunks.length === RECEIVE_BATCH) {
        try {
          transfer.parts.push(new Blob(transfer.chunks));
          transfer.chunks.length = 0;
        } catch {
          this.#abortIncoming('浏览器无法保存该附件，请让对方重试。');
          return;
        }
      }
      transfer.received += size;
      transfer.lastActivity = Date.now();
      if (transfer.received - transfer.lastAck >= RECEIPT_INTERVAL || transfer.received === transfer.size) {
        transfer.lastAck = transfer.received;
        this.#sendControl({ t: 'ack', id: transfer.id, bytes: transfer.received }, true);
        this.#reportIncoming(transfer);
      }
    }

    #reportIncoming({ id, name, type, size, received }) {
      this.#emit('fileprogress', { id, name, type, size, received });
    }

    #finishIncoming() {
      const { id, name, type, size, received, chunks, parts, timer } = this.#incoming;
      if (received !== size) {
        this.#abortIncoming('附件传输不完整，请让对方重试。');
        return;
      }
      let blob;
      try {
        blob = new Blob([...parts, ...chunks], { type });
      } catch {
        this.#abortIncoming('浏览器无法保存该附件，请让对方重试。');
        return;
      }
      clearTimeout(timer);
      this.#incoming = null;
      this.#receivedBytes += size;
      this.#receivedCount += 1;
      this.#sendControl({ t: 'done', id }, true);
      this.#emit('file', { id, name, type, size, blob });
    }

    #abortIncoming(message, notify = true) {
      const { id, name, timer, release } = this.#incoming;
      clearTimeout(timer);
      this.#incoming = null;
      release?.();
      if (notify) this.#sendControl({ t: 'reject', id }, true);
      this.#emit('transfererror', { id, name, message });
    }
  }

  window.LanChatPeer = LanChatPeer;
})();
