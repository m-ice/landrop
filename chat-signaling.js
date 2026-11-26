'use strict';

const { randomBytes, randomInt, timingSafeEqual, createHash } = require('node:crypto');
const { inflateSync } = require('node:zlib');

const ROOM_TTL = 10 * 60 * 1000;
const MEMBER_TTL = 3 * 60 * 1000;
const REQUEST_TTL = 5 * 60 * 1000;
const MAX_ROOMS = 128;
const MAX_ROOMS_PER_IP = 12;
const MAX_MEMBERS = 6;
const MAX_REQUESTS = 16;
const MAX_PENDING = 8;
const REQUEST_CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const TOKEN_LIMIT = 16000;
const SIGNAL_ID = /^[A-Za-z0-9_-]{22}$/;
const ROOM_PATH = /^\/api\/chat\/rooms\/([A-Za-z0-9_-]{24})(?:\/(state|requests|pairs|members)(?:\/([A-Za-z0-9_-]{24}))?)?$/;

function digest(value) {
  return createHash('sha256').update(value).digest();
}

function newId() {
  return randomBytes(18).toString('base64url');
}

function newCredential() {
  return randomBytes(32).toString('base64url');
}

function newRequestCode(requests) {
  const reserved = new Set([...requests.values()].map(({ code }) => code));
  let code;
  do {
    code = Array.from({ length: 4 }, () =>
      REQUEST_CODE_ALPHABET[randomInt(REQUEST_CODE_ALPHABET.length)]).join('');
  } while (reserved.has(code));
  return code;
}

function readCredential(req) {
  const token = /^Bearer ([A-Za-z0-9_-]{43})$/i.exec(req.headers.authorization || '')?.[1];
  return token ? digest(token) : null;
}

function readSignal(value, kind) {
  if (typeof value !== 'string' || value.length > TOKEN_LIMIT || !/^LC1\.[zu][A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const encoded = Buffer.from(value.slice(5), 'base64url');
    const bytes = value[4] === 'z' ? inflateSync(encoded, { maxOutputLength: TOKEN_LIMIT }) : encoded;
    const signal = JSON.parse(bytes.toString('utf8'));
    if (!Array.isArray(signal) || signal.length !== 4) return null;
    const [tag, id, name, sdp] = signal;
    if (tag !== kind || typeof id !== 'string' || !SIGNAL_ID.test(id) || typeof name !== 'string' ||
        name.length > 40 || typeof sdp !== 'string' || sdp.length > 10000 || !sdp.startsWith('v=0\n')) return null;
    return id;
  } catch {
    return null;
  }
}

// The signaling service holds only pairing metadata. Browsers exchange content on WebRTC data channels.
function createChatSignaling({ assert, json, readJson, cleanText, joinOrigins }) {
  const rooms = new Map();

  function removeMember(room, id) {
    room.members.delete(id);
    room.requests.delete(id);
    for (const [pairId, pair] of room.pairs) {
      if (pair.initiator === id || pair.responder === id) room.pairs.delete(pairId);
    }
  }

  function rejectRequest(request, now) {
    request.status = 'rejected';
    request.expiresAt = now + REQUEST_TTL;
  }

  function expireRequestsAndMembers(room, now) {
    for (const [id, request] of room.requests) {
      if (request.status === 'approved' && request.lastSeen + MEMBER_TTL <= now) removeMember(room, id);
      else if (request.status === 'pending' && request.expiresAt <= now) rejectRequest(request, now);
      else if (request.status === 'rejected' && request.expiresAt <= now) room.requests.delete(id);
    }
  }

  function prune(now = Date.now()) {
    for (const [id, room] of rooms) {
      if (room.expiresAt <= now) rooms.delete(id);
      else expireRequestsAndMembers(room, now);
    }
  }

  function getRoom(id) {
    const room = rooms.get(id);
    const now = Date.now();
    if (room && room.expiresAt <= now) rooms.delete(id);
    assert(rooms.has(id), 404, '此邀请已过期或房间已结束。');
    expireRequestsAndMembers(room, now);
    return room;
  }

  function requireOwner(req, room) {
    const credential = readCredential(req);
    assert(credential && timingSafeEqual(credential, room.owner.credential), 403, '需要房间发起者凭据。');
  }

  function requireParticipant(req, room) {
    const credential = readCredential(req);
    assert(credential, 403, '需要房间成员凭据。');
    if (timingSafeEqual(credential, room.owner.credential)) return room.owner;
    const participant = [...room.requests.values()].find(request => timingSafeEqual(credential, request.credential));
    assert(participant, 403, '成员凭据无效或已过期。');
    return participant;
  }

  function pendingRequests(room) {
    return [...room.requests.values()].filter(request => request.status === 'pending');
  }

  function getName(value) {
    return typeof value === 'string' ? cleanText(value) || '未命名设备' : '未命名设备';
  }

  async function createRoom(req, res) {
    const { name } = await readJson(req);
    const now = Date.now();
    prune(now);
    assert(rooms.size < MAX_ROOMS, 429, '当前聊天房间过多，请稍后再试。');
    const address = req.socket.remoteAddress;
    const count = [...rooms.values()].filter(room => room.address === address).length;
    assert(count < MAX_ROOMS_PER_IP, 429, '创建房间过多，请稍后再试。');
    const room = newId();
    const memberId = newId();
    const ownerToken = newCredential();
    const expiresAt = now + ROOM_TTL;
    const owner = { id: memberId, name: getName(name), credential: digest(ownerToken), status: 'approved' };
    rooms.set(room, {
      address, owner, expiresAt, members: new Map([[memberId, owner]]), requests: new Map(), pairs: new Map()
    });
    json(res, 201, { room, ownerToken, memberId, expiresAt, joinOrigins: joinOrigins() });
  }

  async function addRequest(req, res, roomId) {
    const { name } = await readJson(req);
    const room = getRoom(roomId);
    assert(room.members.size < MAX_MEMBERS, 409, '房间人数已满。');
    assert(room.requests.size < MAX_REQUESTS && pendingRequests(room).length < MAX_PENDING, 429, '此房间的加入申请过多。');
    const id = newId();
    const requestToken = newCredential();
    const code = newRequestCode(room.requests);
    room.requests.set(id, {
      id, code, name: getName(name), credential: digest(requestToken), status: 'pending', expiresAt: Date.now() + REQUEST_TTL
    });
    json(res, 201, { id, requestToken, code });
  }

  async function decideRequest(req, res, roomId, requestId) {
    requireOwner(req, getRoom(roomId));
    const { decision } = await readJson(req);
    assert(decision === 'approved' || decision === 'rejected', 400, '申请处理操作无效。');
    const room = getRoom(roomId);
    const request = room.requests.get(requestId);
    assert(request, 404, '未找到此加入申请。');
    if (request.status === decision) {
      json(res, 200, { status: decision });
      return;
    }
    assert(request.status === 'pending', 409, '此加入申请已结束。');
    const now = Date.now();
    if (decision === 'approved') {
      assert(room.members.size < MAX_MEMBERS, 409, '房间人数已满。');
      for (const member of room.members.values()) {
        room.pairs.set(newId(), {
          initiator: member.id, responder: request.id, sessionId: null, offer: null, answer: null
        });
      }
      request.status = 'approved';
      request.lastSeen = now;
      room.members.set(request.id, request);
    } else {
      rejectRequest(request, now);
    }
    json(res, 200, { status: decision });
  }

  function getState(req, res, room) {
    const participant = requireParticipant(req, room);
    if (participant.status !== 'approved') {
      json(res, 200, { status: participant.status });
      return;
    }
    const isOwner = participant === room.owner;
    const now = Date.now();
    if (isOwner) room.expiresAt = now + ROOM_TTL;
    else participant.lastSeen = now;
    const pairs = [];
    for (const [id, pair] of room.pairs) {
      const initiator = pair.initiator === participant.id;
      if (!initiator && pair.responder !== participant.id) continue;
      pairs.push({ id, remoteId: initiator ? pair.responder : pair.initiator, initiator,
        offer: pair.offer, answer: pair.answer });
    }
    const members = [...room.members.values()].map(({ id, name }) => ({ id, name }));
    const requests = isOwner ? pendingRequests(room).map(({ id, name, code }) => ({ id, name, code })) : [];
    json(res, 200, { status: 'approved', memberId: participant.id, expiresAt: room.expiresAt, members, pairs, requests });
  }

  function requirePair(req, room, id) {
    const participant = requireParticipant(req, room);
    const pair = room.pairs.get(id);
    assert(pair, 404, '设备连接已关闭。');
    assert(participant.id === pair.initiator || participant.id === pair.responder, 403, '此连接属于其他设备。');
    return { pair, initiator: participant.id === pair.initiator };
  }

  async function setPairSignal(req, res, roomId, pairId) {
    requirePair(req, getRoom(roomId), pairId);
    const body = await readJson(req);
    const { pair, initiator } = requirePair(req, getRoom(roomId), pairId);
    const key = initiator ? 'offer' : 'answer';
    const value = body[key];
    const sessionId = readSignal(value, initiator ? 'invite' : 'request');
    assert(sessionId, 400, '连接信息无效。');
    if (!initiator) assert(sessionId === pair.sessionId, 400, '连接信息与当前申请不匹配。');
    assert(!pair[key] || pair[key] === value, 409, '此连接信息已提交。');
    if (initiator) pair.sessionId = sessionId;
    pair[key] = value;
    json(res, 200, { ok: true });
  }

  async function handle(req, res, pathname) {
    const method = req.method;
    if (method === 'POST' && pathname === '/api/chat/rooms') {
      await createRoom(req, res); return;
    }
    const match = ROOM_PATH.exec(pathname);
    assert(match, 404, '聊天接口不存在。');
    const [, roomId, collection, id] = match;
    const room = getRoom(roomId);
    if (!collection && method === 'GET') {
      json(res, 200, { hostName: room.owner.name, expiresAt: room.expiresAt }); return;
    }
    if (!collection && method === 'DELETE') {
      requireOwner(req, room);
      rooms.delete(roomId);
      json(res, 200, { ok: true }); return;
    }
    if (collection === 'state' && !id && method === 'GET') {
      getState(req, res, room); return;
    }
    if (collection === 'requests' && !id && method === 'POST') {
      await addRequest(req, res, roomId); return;
    }
    if (collection === 'requests' && id && method === 'PATCH') {
      await decideRequest(req, res, roomId, id); return;
    }
    if (collection === 'pairs' && id && method === 'PUT') {
      await setPairSignal(req, res, roomId, id); return;
    }
    if (collection === 'members' && id && method === 'DELETE') {
      const participant = requireParticipant(req, room);
      assert(participant !== room.owner && participant.id === id, 403, '只能退出本设备的房间会话。');
      removeMember(room, id);
      json(res, 200, { ok: true }); return;
    }
    assert(false, 404, '聊天接口不存在。');
  }

  return { handle, prune };
}

module.exports = { createChatSignaling };
