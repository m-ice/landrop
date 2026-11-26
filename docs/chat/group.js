'use strict';

(() => {
  const MAX_MEMBERS = 6;
  const MAX_ATTACHMENTS = 250;
  const MAX_CACHED_CHUNKS = 128;
  const POLL_INTERVAL = 850;

  class SignalingError extends Error {
    constructor(status, message) {
      super(message);
      this.status = status;
    }
  }

  async function request(path, method = 'GET', body, token, keepalive = false) {
    const response = await fetch('/api/chat/rooms' + path, {
      method, keepalive, cache: 'no-store', credentials: 'omit',
      signal: AbortSignal.timeout(6000),
      headers: {
        ...(method !== 'GET' && { 'X-Landrop': '1' }),
        ...(body !== undefined && { 'Content-Type': 'application/json' }),
        ...(token && { Authorization: 'Bearer ' + token })
      },
      ...(body !== undefined && { body: JSON.stringify(body) })
    });
    const data = await response.json();
    if (!response.ok) throw new SignalingError(response.status, data.error || '暂时无法处理聊天请求。');
    return data;
  }

  class LanChatRoom extends EventTarget {
    static MAX_MEMBERS = MAX_MEMBERS;

    #name;
    #room = '';
    #token = '';
    #host = false;
    #memberId = '';
    #roster = [];
    #links = new Map();
    #gathering = false;
    #pollTimer;
    #closed = false;
    #lastState = '';
    #lastRequests = '';
    #ownerRequests = [];
    #requestVersion = 0;
    #stateVersion = 0;
    #managementDown = false;
    #receivedBytes = 0;
    #receivedCount = 0;

    constructor(name) {
      super();
      this.#name = name;
    }

    get connected() {
      return [...this.#links.values()].some(link => link.peer?.connected);
    }

    get members() {
      return this.#roster.map(member => {
        const link = this.#links.get(member.id);
        return { ...member, connected: Boolean(link?.peer?.connected), failed: Boolean(link?.failed) };
      });
    }

    get remoteName() {
      return '局域网会话';
    }

    async create() {
      const { room, ownerToken, memberId, ...details } = await request('', 'POST', { name: this.#name });
      this.#start(room, ownerToken, memberId, true);
      return { room, ...details };
    }

    inspect(room) {
      if (!/^[A-Za-z0-9_-]{24}$/.test(room)) throw new Error('此邀请链接不完整。');
      return request('/' + room);
    }

    async apply(room) {
      if (!/^[A-Za-z0-9_-]{24}$/.test(room)) throw new Error('此邀请链接不完整。');
      const { id, requestToken, code } = await request('/' + room + '/requests', 'POST', { name: this.#name });
      this.#start(room, requestToken, id, false);
      return code;
    }

    async refreshRequests() {
      if (this.#closed || !this.#host) throw new Error('会话已经结束。');
      const version = ++this.#stateVersion;
      const state = await this.#request('/state');
      if (this.#closed) throw new Error('会话已经结束。');
      this.#updateRequests(state.requests, version);
      return this.#ownerRequests;
    }

    async decide(id, decision) {
      if (this.#closed || !this.#host) throw new Error('会话已经结束。');
      await this.#request('/requests/' + id, 'PATCH', { decision });
      if (!this.#closed) {
        this.#updateRequests(this.#ownerRequests.filter(request => request.id !== id), ++this.#stateVersion);
      }
    }

    async sendText(text) {
      const peers = this.#connectedLinks();
      const results = await Promise.allSettled(peers.map(link => link.peer.sendText(text)));
      this.#requireDelivery(results, '消息');
    }

    async sendFile(file, progress) {
      const peers = this.#connectedLinks();
      const received = new Map();
      const chunks = new Map();
      const readChunk = peers.length > 1 ? (start, end) => {
        const key = start + ':' + end;
        const cached = chunks.get(key);
        if (cached) return cached;
        const reading = file.slice(start, end).arrayBuffer();
        if (chunks.size >= MAX_CACHED_CHUNKS) chunks.delete(chunks.keys().next().value);
        chunks.set(key, reading);
        return reading;
      } : undefined;
      const results = await Promise.allSettled(peers.map(link => link.peer.sendFile(file, bytes => {
        received.set(link.id, bytes);
        const total = [...received.values()].reduce((sum, size) => sum + size, 0);
        progress?.(total, file.size * peers.length);
      }, readChunk)));
      this.#requireDelivery(results, '附件');
    }

    close() {
      if (this.#closed) return;
      if (this.#room && this.#token) {
        const path = this.#host ? '' : '/members/' + this.#memberId;
        this.#request(path, 'DELETE', undefined, true).catch(() => {});
      }
      this.#finish('closed', '你已退出会话。');
    }

    #request(path, method, body, keepalive) {
      return request('/' + this.#room + path, method, body, this.#token, keepalive);
    }

    #start(room, token, memberId, host) {
      this.#room = room;
      this.#token = token;
      this.#memberId = memberId;
      this.#host = host;
      if (this.#closed) {
        this.#request(host ? '' : '/members/' + memberId, 'DELETE', undefined, true).catch(() => {});
        return;
      }
      this.#emitState();
      void this.#poll();
    }

    async #poll() {
      const version = ++this.#stateVersion;
      try {
        const state = await this.#request('/state');
        if (this.#closed) return;
        this.#managementDown = false;
        if (state.status === 'rejected') {
          this.#finish('rejected', '创建者拒绝了申请。你可以重新申请。');
          return;
        }
        if (state.status === 'approved') this.#update(state, version);
        this.#emitState();
      } catch (error) {
        if (this.#closed) return;
        if (error.status === 403 || error.status === 404) {
          this.#finish('closed', '会话已结束或邀请已过期。');
          return;
        }
        this.#managementDown = true;
        this.#emitState();
      } finally {
        if (!this.#closed) this.#pollTimer = setTimeout(() => { void this.#poll(); }, POLL_INTERVAL);
      }
    }

    #updateRequests(requests, version) {
      // An older poll can finish after a manual lookup or a completed decision.
      if (version < this.#requestVersion) return;
      this.#requestVersion = version;
      const signature = JSON.stringify(requests);
      if (signature === this.#lastRequests) return;
      this.#lastRequests = signature;
      this.#ownerRequests = requests;
      this.#emit('requests', { requests });
    }

    #update(state, version) {
      this.#roster = state.members.filter(member => member.id !== this.#memberId);
      const pairIds = new Set(state.pairs.map(pair => pair.id));
      for (const [memberId, link] of this.#links) {
        if (pairIds.has(link.id)) continue;
        this.#links.delete(memberId);
        link.peer.close();
      }
      if (this.#host) this.#updateRequests(state.requests, version);
      const names = new Map(this.#roster.map(member => [member.id, member.name]));
      for (const pair of state.pairs) {
        let link = this.#links.get(pair.remoteId);
        if (!link) {
          link = this.#prepareLink(pair, names.get(pair.remoteId));
          this.#links.set(pair.remoteId, link);
        }
        if (!link.busy && !link.failed && !link.peer.connected) void this.#advanceLink(link, pair);
      }
    }

    #prepareLink({ id, remoteId }, name) {
      const link = { id, remoteId, name, busy: false, failed: false, attempts: 0, signal: null, sent: false, applied: false };
      this.#bindPeer(link);
      return link;
    }

    #bindPeer(link) {
      const peer = new window.LanChatPeer(this.#name, { reserveIncoming: size => this.#reserveIncoming(size) });
      const { id, remoteId, name } = link;
      link.peer = peer;
      peer.addEventListener('statechange', ({ detail }) => {
        if (this.#closed || this.#links.get(remoteId) !== link || link.peer !== peer || link.busy && !link.signal) return;
        if (['disconnected', 'closed', 'failed'].includes(detail.state)) link.failed = true;
        this.#emitState();
      });
      for (const type of ['text', 'file', 'fileprogress', 'transfererror']) {
        peer.addEventListener(type, ({ detail }) => {
          if (this.#closed) return;
          const attachment = detail.id ? { id: id + ':' + detail.id } : {};
          this.#emit(type, { ...detail, ...attachment, from: name, fromId: remoteId });
        });
      }
    }

    async #advanceLink(link, pair) {
      const gather = !link.signal && (pair.initiator || pair.offer);
      // Some browsers suppress later network candidates when several connections gather at once.
      if (gather && this.#gathering) return;
      link.busy = true;
      try {
        if (gather) {
          this.#gathering = true;
          link.attempts += 1;
          try {
            link.signal = pair.initiator
              ? { offer: await link.peer.createInvite() }
              : { answer: await link.peer.createRequest(pair.offer) };
          } finally {
            this.#gathering = false;
          }
        }
        if (this.#closed || this.#links.get(pair.remoteId) !== link) return;
        if (link.signal && !link.sent) {
          await this.#request('/pairs/' + pair.id, 'PUT', link.signal);
          link.sent = true;
        }
        if (pair.initiator && pair.answer && !link.applied && !this.#closed) {
          await link.peer.approveRequest(pair.answer);
          link.applied = true;
        }
      } catch (error) {
        if (this.#closed || this.#links.get(pair.remoteId) !== link) return;
        if (gather && !link.signal && link.attempts < 3) {
          const previous = link.peer;
          this.#bindPeer(link);
          previous.close();
          return;
        }
        // Retry signal publication when the LAN host is temporarily unreachable.
        if (!link.signal || error instanceof SignalingError || pair.answer && link.sent) {
          link.failed = true;
          link.peer.close();
          this.#emitState();
        }
      } finally {
        link.busy = false;
      }
    }

    #reserveIncoming(size) {
      if (this.#receivedBytes + size > window.LanChatPeer.MAX_FILE_BYTES || this.#receivedCount >= MAX_ATTACHMENTS) return null;
      this.#receivedBytes += size;
      this.#receivedCount += 1;
      return () => {
        this.#receivedBytes -= size;
        this.#receivedCount -= 1;
      };
    }

    #connectedLinks() {
      const peers = [...this.#links.values()].filter(link => link.peer.connected);
      if (!peers.length) throw new Error('请等待其他成员连入会话。');
      return peers;
    }

    #requireDelivery(results, label) {
      const count = results.filter(result => result.status === 'fulfilled').length;
      if (count === results.length) return;
      if (results.length === 1) throw results[0].reason;
      throw new Error(count ? `${label}已发给 ${count} 人，${results.length - count} 人发送失败。` : `${label}发送失败，请重试。`);
    }

    #emitState() {
      const members = this.members;
      const count = members.filter(member => member.connected).length;
      const forming = members.some(member => !member.connected && !member.failed);
      const state = count ? 'connected' : forming ? 'connecting' : members.length ? 'disconnected' : 'waiting';
      let message;
      if (this.#managementDown) message = '暂时无法联系局域网主机。';
      else if (count) message = `已与 ${count} 位成员建立直连。`;
      else if (forming) message = '正在与会话成员建立连接。';
      else if (members.length) message = '成员连接已中断。请让对方重新加入。';
      else message = this.#host ? '等待其他设备申请加入。' : '申请已发送，等待创建者同意。';
      this.#publishState(state, message, members);
    }

    #finish(state, message) {
      this.#closed = true;
      clearTimeout(this.#pollTimer);
      for (const link of this.#links.values()) link.peer.close();
      this.#links.clear();
      this.#roster = [];
      this.#publishState(state, message, []);
    }

    #publishState(state, message, members) {
      const signature = JSON.stringify([state, message, members]);
      if (signature === this.#lastState) return;
      this.#lastState = signature;
      this.#emit('statechange', { state, message, members });
    }

    #emit(type, detail) {
      this.dispatchEvent(new CustomEvent(type, { detail }));
    }
  }

  window.LanChatRoom = LanChatRoom;
})();
