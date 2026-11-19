#!/usr/bin/env python3
"""Independent replay of Veil qledger-v1 batches from a transcript.

A second implementation that shares no code with @qorechain/rdk or the Node
scripts in this repository: Python hashlib for SHA-256 and SHAKE256,
dilithium-py (FIPS 204) for ML-DSA-44, its own bech32 and sparse Merkle tree.
It follows the qledger-v1 encoding and roots of RDK 0.9.0 and reads only the
transcript: the recorded batch fields and the raw public inbox entries.

    pip install dilithium-py
    python3 -I tools/replay_independent.py evidence/withdrawal/transcript.jsonl
"""
import hashlib, json, struct, sys
from dilithium_py.ml_dsa import ML_DSA_44

U64 = (1 << 64) - 1
I64 = (1 << 63) - 1
PK, SIG = 1312, 2420

sha = lambda b: hashlib.sha256(b).digest()
be64 = lambda v: struct.pack('>Q', v)
u32 = lambda v: struct.pack('>I', v)
lp = lambda b: u32(len(b)) + b
def shake(*parts):
    h = hashlib.shake_256()
    for p in parts: h.update(p)
    return h.digest(32)

# --- bech32 canonical check (BIP-173 checksum, length limit lifted) ---
CH = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l'
def _polymod(v):
    g = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3]
    c = 1
    for x in v:
        b = c >> 25; c = ((c & 0x1ffffff) << 5) ^ x
        for i in range(5): c ^= g[i] if (b >> i) & 1 else 0
    return c
def canonical_qor(s):
    if s != s.lower() or '1' not in s: return False
    hrp, data = s.rsplit('1', 1)
    if hrp != 'qor' or len(data) < 6 or any(c not in CH for c in data): return False
    d = [CH.index(c) for c in data]
    if _polymod([ord(c) >> 5 for c in hrp] + [0] + [ord(c) & 31 for c in hrp] + d) != 1: return False
    words, acc, bits, out = d[:-6], 0, 0, []
    for w in words:
        acc = (acc << 5) | w; bits += 5
        while bits >= 8: bits -= 8; out.append((acc >> bits) & 0xff)
    if bits >= 5 or (acc & ((1 << bits) - 1)): return False
    return 0 < len(out) <= 255

# --- inbox accumulator ---
def acc_step(chain, rollup, prev, seq, height, poster, payload):
    return sha(b'qorechain/rdk/inbox/v1' + lp(chain.encode()) + lp(rollup.encode()) + prev
               + be64(seq) + be64(height) + lp(poster.encode()) + sha(payload))
def range_hash(chain, rollup, frm, to, a, b):
    return sha(b'qorechain/rdk/inbox-range/v1' + lp(chain.encode()) + lp(rollup.encode())
               + be64(frm) + be64(to) + a + b)

# --- sparse Merkle state, depth 256 ---
DEPTH = 256
EMPTY = [sha(b'\x00qledger/v1/empty')]
node = lambda l, r: sha(b'\x01' + l + r)
for _ in range(DEPTH): EMPTY.append(node(EMPTY[-1], EMPTY[-1]))
def leaf(i, bal, n):
    return EMPTY[0] if bal == 0 and n == 0 else sha(b'\x00' + i + be64(bal) + be64(n))
bit = lambda i, k: (i[k >> 3] >> (7 - (k & 7))) & 1
def subtree(st, d, ids):
    if not ids: return EMPTY[DEPTH - d]
    if len(ids) == 1:
        i = ids[0]; cur = leaf(i, *st[i])
        for dd in range(DEPTH, d, -1):
            cur = node(cur, EMPTY[DEPTH - dd]) if bit(i, dd - 1) == 0 else node(EMPTY[DEPTH - dd], cur)
        return cur
    L = [i for i in ids if bit(i, d) == 0]; R = [i for i in ids if bit(i, d) == 1]
    return node(subtree(st, d + 1, L), subtree(st, d + 1, R))
def root(st):
    return subtree(st, 0, sorted(k for k, v in st.items() if v != (0, 0)))

COUNTER = sha(b'qledger/v1/withdrawal-counter')
get = lambda st, k: st.get(k, (0, 0))
def setv(st, k, b, n):
    if b == 0 and n == 0: st.pop(k, None)
    else: st[k] = (b, n)

def decode_tx(b):
    if len(b) < 2 or b[0] != 1 or b[1] != 1 or len(b) < 2 + PK + 9: return None
    p = 2; pk = b[p:p + PK]; p += PK
    kind = b[p]; p += 1
    nonce, = struct.unpack('>Q', b[p:p + 8]); p += 8
    tx = dict(pk=pk, kind=kind, nonce=nonce)
    if kind == 1:
        if len(b) < p + 32: return None
        tx['to'] = b[p:p + 32]; p += 32
    elif kind == 2:
        if len(b) < p + 1: return None
        n = b[p]; p += 1
        if n == 0 or n > 90 or len(b) < p + n: return None
        tx['rcpt'] = b[p:p + n]; p += n
    else: return None
    if len(b) != p + 8 + SIG: return None
    tx['amount'], = struct.unpack('>Q', b[p:p + 8])
    tx['unsigned'] = b[:p + 8]; tx['sig'] = b[p + 8:]
    return tx

def verify_tx(tx, chain, rollup):
    c, r = chain.encode(), rollup.encode()
    msg = sha(b'qledger/v1/tx' + u32(len(c)) + c + u32(len(r)) + r + tx['unsigned'])
    return ML_DSA_44.verify(tx['pk'], msg, tx['sig'], ctx=b'qledger/v1')

def execute(chain, rollup, st, entries, log):
    ws = []
    for e in entries:
        pl = e['payload']
        if e['poster'].startswith('deposit:'):
            if len(pl) != 44 or pl[:4] != b'QLDP': log.append('deposit: malformed, skipped'); continue
            acct, amt = pl[4:36], struct.unpack('>Q', pl[36:])[0]
            if acct == COUNTER: continue
            b, n = get(st, acct)
            if b > U64 - amt: continue
            setv(st, acct, b + amt, n); log.append(f'deposit {amt} -> {acct.hex()[:16]}…'); continue
        tx = decode_tx(pl)
        if not tx: log.append('non-tx payload, skipped'); continue
        if not verify_tx(tx, chain, rollup): log.append('bad signature, skipped'); continue
        frm = sha(b'qledger/v1/account' + b'\x01' + tx['pk'])
        b, n = get(st, frm)
        if tx['nonce'] != n or tx['amount'] == 0 or b < tx['amount'] or n == U64:
            log.append(f'tx from {frm.hex()[:16]}… rejected (nonce/balance)'); continue
        if tx['kind'] == 1:
            to = tx['to']
            if to == COUNTER: continue
            if to == frm: setv(st, frm, b, n + 1); continue
            tb, tn = get(st, to)
            if tb > U64 - tx['amount']: continue
            setv(st, frm, b - tx['amount'], n + 1); setv(st, to, tb + tx['amount'], tn)
            log.append(f'transfer {tx["amount"]} {frm.hex()[:16]}… -> {to.hex()[:16]}… nonce {n}')
        else:
            try: rc = tx['rcpt'].decode('utf-8', 'strict')
            except UnicodeDecodeError: continue
            if tx['amount'] > I64 or not canonical_qor(rc): log.append('withdraw: bad recipient'); continue
            nxt = get(st, COUNTER)[0]
            if nxt == U64: continue
            setv(st, frm, b - tx['amount'], n + 1); setv(st, COUNTER, nxt + 1, 0)
            ws.append((nxt, rc, tx['amount']))
            log.append(f'withdraw #{nxt} {tx["amount"]} {frm.hex()[:16]}… -> {rc} nonce {n}')
    return ws

def w_leaf(chain, rollup, idx, rc, amt):
    return shake(lp(b'qorechain-rdk-withdrawal/v2'), lp(chain.encode()), lp(rollup.encode()),
                 be64(idx), lp(rc.encode()), lp(b'uqor'), be64(amt))
def w_root(chain, rollup, ws):
    if not ws: return b''
    n = 1
    while n < len(ws): n *= 2
    lvl = [bytes(32)] * n
    for i, rc, a in ws: lvl[i % n] = w_leaf(chain, rollup, i, rc, a)
    while len(lvl) > 1: lvl = [shake(lvl[2 * k], lvl[2 * k + 1]) for k in range(len(lvl) // 2)]
    return lvl[0]

def main(path):
    recs = [json.loads(l) for l in open(path) if l.strip()]
    st, acc, consumed, ok = {}, bytes(32), 0, True
    def check(name, got, want):
        nonlocal ok
        good = got == want; ok &= good
        print(f'  {"OK " if good else "BAD"} {name}: {got}' + ('' if good else f' (transcript {want})'))
    for rec in recs:
        bt, chain = rec['batch'], rec['chainId']; rid = bt['rollupId']
        print(f'batch {bt["batchIndex"]} ({bt["status"]}), range ({bt["inboxStart"]}, {bt["inboxEnd"]}]')
        check('inboxStart == consumed cursor', bt['inboxStart'], consumed)
        check('prevStateRoot', root(st).hex(), bt['prevStateRoot'])
        ents = [dict(height=int(e['height']), poster=e['poster'], payload=bytes.fromhex(e['payloadHex'])) for e in rec['entries']]
        check('entry count == txCount', len(ents), bt['txCount'])
        check('entry count == range length', len(ents), bt['inboxEnd'] - bt['inboxStart'])
        a0 = acc
        for k, e in enumerate(ents):
            acc = acc_step(chain, rid, acc, bt['inboxStart'] + k + 1, e['height'], e['poster'], e['payload'])
        check('accTo', acc.hex(), rec['accTo'])
        check('dataHash', range_hash(chain, rid, bt['inboxStart'], bt['inboxEnd'], a0, acc).hex(), bt['dataHash'])
        log = []
        ws = execute(chain, rid, st, ents, log)
        for l in log: print('    ' + l)
        check('stateRoot', root(st).hex(), bt['stateRoot'])
        check('withdrawalsRoot', w_root(chain, rid, ws).hex(), bt['withdrawalsRoot'])
        check('withdrawals', [[str(i), r, str(a)] for i, r, a in ws],
              [[w['index'], w['recipient'], w['amount']] for w in rec['withdrawals']])
        consumed = bt['inboxEnd']
    print('ledger after replay:')
    for k, (b, n) in sorted(st.items()):
        print(f'  {"COUNTER" if k == COUNTER else k.hex()}  balance={b} nonce={n}')
    print('ALL CHECKS PASSED' if ok else 'MISMATCH')
    sys.exit(0 if ok else 1)

if __name__ == '__main__':
    main(sys.argv[1])
