from flask import Flask, request, jsonify, g
from flask_cors import CORS
from werkzeug.security import generate_password_hash, check_password_hash
from itsdangerous import URLSafeTimedSerializer, BadSignature, SignatureExpired
from functools import wraps
from pathlib import Path
import sqlite3, secrets, argparse, os
from datetime import datetime, timezone

BASE = Path(__file__).resolve().parent
DB_PATH = Path(os.getenv('LICENSE_DB', BASE / 'data.sqlite3'))
SECRET_PATH = BASE / 'secret.key'

app = Flask(__name__)
CORS(app, resources={r'/api/*': {'origins': '*'}}, methods=['GET','POST','PUT','PATCH','DELETE','OPTIONS'], allow_headers=['Content-Type','Authorization'])

if SECRET_PATH.exists():
    SECRET = SECRET_PATH.read_text().strip()
else:
    SECRET = secrets.token_urlsafe(48)
    SECRET_PATH.write_text(SECRET)

serializer = URLSafeTimedSerializer(SECRET, salt='damarzdev-license-api-v1')

SCHEMA = '''
CREATE TABLE IF NOT EXISTS users (
 id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL,
 role TEXT NOT NULL, username TEXT, status TEXT NOT NULL DEFAULT 'active',
 credit TEXT DEFAULT '0', parentAdminId TEXT, until TEXT, createdAt TEXT, updatedAt TEXT
);
CREATE TABLE IF NOT EXISTS keys (
 id TEXT PRIMARY KEY, key TEXT UNIQUE NOT NULL, tag TEXT, expires TEXT NOT NULL,
 devices INTEGER DEFAULT 0, max_devices INTEGER DEFAULT 1, device_ids TEXT DEFAULT '[]',
 status TEXT DEFAULT 'active', createdAt TEXT, updatedAt TEXT,
 createdBy TEXT, createdByUsername TEXT, createdByRole TEXT, ownerId TEXT, parentAdminId TEXT
);
CREATE TABLE IF NOT EXISTS resellers (
 id TEXT PRIMARY KEY, userId TEXT UNIQUE, username TEXT, email TEXT, credit TEXT DEFAULT '0',
 createdKeys INTEGER DEFAULT 0, until TEXT, status TEXT DEFAULT 'active', parentAdminId TEXT,
 createdAt TEXT, updatedAt TEXT
);
CREATE TABLE IF NOT EXISTS admins (
 id TEXT PRIMARY KEY, userId TEXT UNIQUE, username TEXT, email TEXT, credit TEXT DEFAULT '0',
 until TEXT, status TEXT DEFAULT 'active', createdAt TEXT, updatedAt TEXT
);
CREATE TABLE IF NOT EXISTS activities (
 id TEXT PRIMARY KEY, action TEXT, details TEXT, actor TEXT, parentAdminId TEXT, timestamp TEXT
);
CREATE TABLE IF NOT EXISTS system (
 id TEXT PRIMARY KEY, active_keys INTEGER DEFAULT 0, total_keys INTEGER DEFAULT 0, credit TEXT DEFAULT '1000', updatedAt TEXT
);
'''

def conn():
    if 'db' not in g:
        g.db = sqlite3.connect(DB_PATH, timeout=10)
        g.db.row_factory = sqlite3.Row
        g.db.execute('PRAGMA foreign_keys=ON')
    return g.db

@app.teardown_appcontext
def close_db(_=None):
    db = g.pop('db', None)
    if db: db.close()

def now(): return datetime.now(timezone.utc).isoformat()
def new_id(): return secrets.token_hex(12)
def json_load(s, default):
    import json
    try: return json.loads(s)
    except Exception: return default

def json_dump(v):
    import json
    return json.dumps(v, separators=(',', ':'))

def row_obj(row):
    if row is None: return None
    d = dict(row)
    for k in ('createdAt','updatedAt','timestamp'):
        if d.get(k): d[k] = {'__timestamp': d[k]}
    if 'device_ids' in d: d['device_ids'] = json_load(d['device_ids'], [])
    return d

def init_db():
    db = sqlite3.connect(DB_PATH)
    db.executescript(SCHEMA)
    db.execute("INSERT OR IGNORE INTO system(id,active_keys,total_keys,credit,updatedAt) VALUES('stats',0,0,'1000',?)", (now(),))
    db.commit(); db.close()


def token_for(user):
    return serializer.dumps({'uid': user['id']})

def current_user():
    h = request.headers.get('Authorization','')
    if not h.startswith('Bearer '): return None
    try:
        data = serializer.loads(h[7:], max_age=60*60*24*30)
    except (BadSignature, SignatureExpired): return None
    row = conn().execute('SELECT * FROM users WHERE id=?', (data.get('uid'),)).fetchone()
    if not row or row['status'] in ('ban','deleted','expired'): return None
    return row

def require_auth(fn):
    @wraps(fn)
    def wrapper(*a, **kw):
        u = current_user()
        if not u: return jsonify(error='Unauthorized', code='unauthorized'), 401
        request.user = u
        return fn(*a, **kw)
    return wrapper

def role_ok(u, role): return u and u['role'] == role

def allowed_read(u, collection, where):
    # Server-side scope enforcement. Client-side role checks are never trusted.
    if collection == 'keys':
        if role_ok(u,'owner'): return None
        if role_ok(u,'admin'): return [('createdBy','==',u['id']),('parentAdminId','==',u['id'])]
        return [('createdBy','==',u['id'])]
    if collection == 'resellers':
        if role_ok(u,'owner'): return None
        if role_ok(u,'admin'): return [('parentAdminId','==',u['id'])]
        return [('userId','==',u['id'])]
    if collection == 'admins': return None if role_ok(u,'owner') else [('id','==',u['id'])]
    if collection == 'activities':
        if role_ok(u,'owner'): return None
        if role_ok(u,'admin'): return [('parentAdminId','==',u['id'])]
        return [('id','==','__none__')]
    if collection == 'system': return None if role_ok(u,'owner') else [('id','==','__none__')]
    if collection == 'users': return None if role_ok(u,'owner') else [('id','==',u['id'])]
    return [('id','==','__none__')]

def build_where(extra):
    out=[]
    for f,op,v in extra:
        if op not in ('==','!='): continue
        out.append((f,op,v))
    return out

def collection_rows(collection, u, filters):
    scope = allowed_read(u, collection, filters)
    filters = build_where(filters)
    # OR scope for admin keys; otherwise scope is a single mandatory condition.
    if collection == 'keys' and u['role']=='admin':
        base = "SELECT * FROM keys WHERE (createdBy=? OR parentAdminId=?)"; args=[u['id'],u['id']]
    elif collection == 'resellers' and u['role']=='admin':
        base = "SELECT * FROM resellers WHERE parentAdminId=?"; args=[u['id']]
    elif scope:
        field,op,val=scope[0]; base=f"SELECT * FROM {collection} WHERE {field} {op} ?"; args=[val]
    else:
        base=f"SELECT * FROM {collection}"; args=[]
    for f,op,v in filters:
        if f not in {'id','key','tag','status','createdBy','createdByUsername','createdByRole','parentAdminId','userId','username'}: continue
        # Don't let caller widen a server scope; additional predicates only narrow results.
        base += f" AND {f} {op} ?"; args.append(v)
    return base,args

@app.get('/api/health')
def health(): return jsonify(ok=True, service='DamarzDev License API', time=now())

@app.post('/api/auth/login')
def login():
    data=request.get_json(silent=True) or {}; email=str(data.get('email','')).strip().lower(); password=str(data.get('password',''))
    row=conn().execute('SELECT * FROM users WHERE lower(email)=?',(email,)).fetchone()
    if not row or not check_password_hash(row['password_hash'],password):
        return jsonify(error='Invalid credentials',code='auth/invalid-credential'),401
    if row['status'] != 'active': return jsonify(error='Account is not active',code='auth/disabled'),403
    if row['until'] and row['until'] != 'PERMANENT' and row['until'] <= now():
        return jsonify(error='Account expired',code='auth/expired'),403
    if row['role'] == 'admin':
        a = conn().execute('SELECT status,until FROM admins WHERE id=? OR userId=? LIMIT 1',(row['id'],row['id'])).fetchone()
        if not a or a['status'] != 'active': return jsonify(error='Admin is not active',code='auth/disabled'),403
        if a['until'] and a['until'] != 'PERMANENT' and a['until'] <= now(): return jsonify(error='Admin expired',code='auth/expired'),403
    if row['role'] == 'reseller':
        r = conn().execute('SELECT status,until FROM resellers WHERE id=? OR userId=? LIMIT 1',(row['id'],row['id'])).fetchone()
        if not r or r['status'] != 'active': return jsonify(error='Reseller is not active',code='auth/disabled'),403
        if r['until'] and r['until'] != 'PERMANENT' and r['until'] <= now(): return jsonify(error='Reseller expired',code='auth/expired'),403
    user={'id':row['id'],'uid':row['id'],'email':row['email'],'username':row['username'],'role':row['role']}
    return jsonify(token=token_for(row),user=user)

@app.post('/api/auth/create')
@require_auth
def create_auth():
    u=request.user; data=request.get_json(silent=True) or {}; email=str(data.get('email','')).strip().lower(); password=str(data.get('password',''))
    if u['role'] not in ('owner','admin'): return jsonify(error='Forbidden'),403
    if not email or len(password)<6: return jsonify(error='Email and password (6+) required'),400
    if conn().execute('SELECT 1 FROM users WHERE email=?',(email,)).fetchone(): return jsonify(error='Account already exists',code='auth/email-already-in-use'),409
    uid=new_id(); t=now()
    conn().execute('INSERT INTO users(id,email,password_hash,role,username,status,createdAt,updatedAt) VALUES(?,?,?,?,?,?,?,?)',(uid,email,generate_password_hash(password),'pending','', 'active',t,t)); conn().commit()
    return jsonify(user={'id':uid,'uid':uid,'email':email,'username':'','role':'pending'})

@app.get('/api/collections/<collection>')
@require_auth
def collection_get(collection):
    if collection not in {'keys','resellers','admins','activities','system','users'}: return jsonify(error='Unknown collection'),404
    raw=request.args.get('where','[]');
    try: filters=__import__('json').loads(raw)
    except Exception: filters=[]
    sql,args=collection_rows(collection,request.user,filters)
    order=request.args.get('orderBy'); direction='DESC' if request.args.get('orderDir','asc').lower()=='desc' else 'ASC'
    if order and order in {'createdAt','timestamp','username','expires','key'}: sql += f' ORDER BY {order} {direction}'
    try: limit=int(request.args.get('limit','0')); sql += (' LIMIT ?' if 0<limit<=500 else '')
    except: limit=0
    if 0<limit<=500: args.append(limit)
    rows=conn().execute(sql,args).fetchall()
    return jsonify(items=[row_obj(r) for r in rows])

@app.get('/api/collections/<collection>/<id>')
@require_auth
def collection_doc_get(collection,id):
    if collection not in {'keys','resellers','admins','activities','system','users'}: return jsonify(error='Unknown collection'),404
    rows=collection_rows(collection,request.user,[['id','==',id]])
    row=conn().execute(*rows).fetchone()
    if not row: return jsonify(error='Not found'),404
    return jsonify(id=id,data=row_obj(row))

def can_write_collection(u, collection, action='write'):
    if collection in ('system','admins'): return u['role']=='owner'
    if collection=='resellers': return u['role'] in ('owner','admin')
    if collection=='keys': return u['role'] in ('owner','admin','reseller')
    if collection=='activities': return True
    if collection=='users': return u['role'] in ('owner','admin')
    return False

def apply_ops(table, data):
    import json
    result={}
    for k,v in (data or {}).items():
        if isinstance(v,dict) and v.get('__op')=='serverTimestamp': result[k]=now()
        elif isinstance(v,dict) and v.get('__op')=='increment': result[k]=('__INC__', float(v.get('value',0)))
        elif k=='device_ids': result[k]=json_dump(v)
        else: result[k]=v
    return result

@app.post('/api/collections/<collection>')
@require_auth
def collection_add(collection):
    if not can_write_collection(request.user,collection): return jsonify(error='Forbidden'),403
    data=(request.get_json(silent=True) or {}).get('data',{}); id=new_id(); data=dict(data); data['id']=id
    if collection=='keys':
        return jsonify(error='Use /api/license/create for license creation'),400
    if collection=='activities':
        data.setdefault('timestamp',now())
    if collection=='users': data.setdefault('id',id)
    return insert_collection(collection,id,data)

def insert_collection(collection,id,data):
    db=conn(); cols=[]; vals=[]
    table=collection
    allowed={
      'activities':['id','action','details','actor','parentAdminId','timestamp'],
      'users':['id','email','password_hash','role','username','status','credit','parentAdminId','until','createdAt','updatedAt'],
      'resellers':['id','userId','username','email','credit','createdKeys','until','status','parentAdminId','createdAt','updatedAt'],
      'admins':['id','userId','username','email','credit','until','status','createdAt','updatedAt'],
      'system':['id','active_keys','total_keys','credit','updatedAt']}.get(collection,[])
    data=apply_ops(table,data)
    for k,v in data.items():
        if k in allowed and not (isinstance(v,tuple) and v[0]=='__INC__'): cols.append(k); vals.append(v)
    if not cols: return jsonify(error='No data'),400
    q=','.join('"'+c+'"' for c in cols); marks=','.join('?' for _ in vals)
    try:
        db.execute(f'INSERT INTO {table} ({q}) VALUES ({marks})',vals); db.commit()
    except sqlite3.IntegrityError as e: return jsonify(error=str(e)),409
    return jsonify(id=id,success=True)

@app.put('/api/collections/<collection>/<id>')
@app.patch('/api/collections/<collection>/<id>')
@require_auth
def collection_update(collection,id):
    if not can_write_collection(request.user,collection): return jsonify(error='Forbidden'),403
    row=conn().execute(f'SELECT * FROM {collection} WHERE id=?',(id,)).fetchone()
    if not row: return jsonify(error='Not found'),404
    # Ownership checks for mutable resources.
    u=request.user
    if collection=='keys' and u['role']!='owner' and not (row['createdBy']==u['id'] or (u['role']=='admin' and row['parentAdminId']==u['id'])): return jsonify(error='Forbidden'),403
    if collection=='resellers' and u['role']=='admin' and row['parentAdminId']!=u['id']: return jsonify(error='Forbidden'),403
    data=(request.get_json(silent=True) or {}).get('data',{}); data=apply_ops(collection,data)
    sets=[]; args=[]
    allowed_cols=set(row.keys())-{'id'}
    for k,v in data.items():
        if k not in allowed_cols: continue
        if isinstance(v,tuple) and v[0]=='__INC__': sets.append(f'{k}={k}+?'); args.append(v[1])
        else: sets.append(f'{k}=?'); args.append(v)
    if not sets: return jsonify(success=True)
    args.append(id); conn().execute(f'UPDATE {collection} SET {", ".join(sets)} WHERE id=?',args); conn().commit()
    return jsonify(success=True)

@app.delete('/api/collections/<collection>/<id>')
@require_auth
def collection_delete(collection,id):
    if not can_write_collection(request.user,collection): return jsonify(error='Forbidden'),403
    row=conn().execute(f'SELECT * FROM {collection} WHERE id=?',(id,)).fetchone()
    if not row: return jsonify(error='Not found'),404
    u=request.user
    if collection=='keys' and u['role']!='owner' and not (row['createdBy']==u['id'] or (u['role']=='admin' and row['parentAdminId']==u['id'])): return jsonify(error='Forbidden'),403
    if collection=='resellers' and u['role']=='admin' and row['parentAdminId']!=u['id']: return jsonify(error='Forbidden'),403
    conn().execute(f'DELETE FROM {collection} WHERE id=?',(id,)); conn().commit(); return jsonify(success=True)

@app.post('/api/batch')
@require_auth
def batch():
    data=request.get_json(silent=True) or {}; ops=data.get('ops',[]); db=conn()
    try:
        db.execute('BEGIN IMMEDIATE')
        for op in ops:
            path=op.get('path',''); parts=path.strip('/').split('/')
            if len(parts)!=4 or parts[0]!='api' or parts[1]!='collections': raise ValueError('Invalid batch path')
            collection,id=parts[2],parts[3]
            row=db.execute(f'SELECT * FROM {collection} WHERE id=?',(id,)).fetchone()
            if not row: continue
            if collection=='keys' and request.user['role']!='owner' and not (row['createdBy']==request.user['id'] or (request.user['role']=='admin' and row['parentAdminId']==request.user['id'])): raise PermissionError()
            for k,v in apply_ops(collection,op.get('data',{})).items():
                if isinstance(v,tuple): db.execute(f'UPDATE {collection} SET {k}={k}+? WHERE id=?',(v[1],id))
                else: db.execute(f'UPDATE {collection} SET {k}=? WHERE id=?',(v,id))
        db.commit(); return jsonify(success=True)
    except PermissionError: db.rollback(); return jsonify(error='Forbidden'),403
    except Exception as e: db.rollback(); return jsonify(error=str(e)),400

@app.post('/api/license/create')
@require_auth
def license_create():
    u=request.user; d=request.get_json(silent=True) or {}
    duration=d.get('duration','hours'); amount=max(1,int(d.get('amount',1))); maxdev=max(1,int(d.get('maxDevices',1)))
    tag=str(d.get('tag') or 'New License'); prefix=str(d.get('prefix') or 'MARZZ').strip(); custom=str(d.get('customKey') or '').strip()
    costs={'hours':2,'day':5,'week':30,'monthly':100,'yearly':500,'permanent':1000}
    if duration not in costs: return jsonify(error='Invalid duration'),400
    import secrets as sec
    key=custom or prefix+'-'+''.join(sec.choice('ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789') for _ in range(8))
    if conn().execute('SELECT 1 FROM keys WHERE key=?',(key,)).fetchone(): return jsonify(error='Key already exists'),409
    cost=costs[duration]
    if duration=='permanent': expires='PERMANENT'
    else:
        from datetime import timedelta
        dt=datetime.now(timezone.utc)
        if duration=='hours': dt+=timedelta(hours=amount)
        elif duration=='day': dt+=timedelta(days=amount)
        elif duration=='week': dt+=timedelta(days=amount*7)
        elif duration=='monthly':
            month=dt.month-1+amount; year=dt.year+month//12; month=month%12+1
            import calendar
            dt=dt.replace(year=year,month=month,day=min(dt.day,calendar.monthrange(year,month)[1]))
        elif duration=='yearly': dt=dt.replace(year=dt.year+amount)
        expires=dt.isoformat()
    db=conn()
    try:
        db.execute('BEGIN IMMEDIATE')
        credit='unlimited' if u['role']=='admin' else (db.execute("SELECT credit FROM system WHERE id='stats'").fetchone()['credit'] if u['role']=='owner' else db.execute('SELECT credit FROM resellers WHERE userId=?',(u['id'],)).fetchone()['credit'])
        if credit!='unlimited' and float(credit)<cost: db.rollback(); return jsonify(error=f'Kredit tidak cukup! Butuh {cost}'),400
        actor='Owner' if u['role']=='owner' else (u['username'] or u['role'])
        parent=u['id'] if u['role']=='admin' else (u['parentAdminId'] or None)
        final_tag=tag if u['role']=='owner' else f'{tag} ({actor})'
        kid=new_id(); t=now()
        db.execute('INSERT INTO keys(id,key,tag,expires,devices,max_devices,device_ids,status,createdAt,updatedAt,createdBy,createdByUsername,createdByRole,ownerId,parentAdminId) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',(kid,key,final_tag,expires,0,maxdev,'[]','active',t,t,u['id'],actor,u['role'],u['id'],parent))
        db.execute('INSERT INTO activities(id,action,details,actor,parentAdminId,timestamp) VALUES(?,?,?,?,?,?)',(new_id(),'Generated Key',f'{key} ({duration})',actor,parent,t))
        if credit!='unlimited':
            if u['role']=='owner': db.execute("UPDATE system SET credit=credit-?,total_keys=total_keys+1,updatedAt=? WHERE id='stats'",(cost,t))
            else: db.execute('UPDATE resellers SET credit=credit-?,createdKeys=createdKeys+1,updatedAt=? WHERE userId=?',(cost,t,u['id']))
        elif u['role']=='reseller': db.execute('UPDATE resellers SET createdKeys=createdKeys+1,updatedAt=? WHERE userId=?',(t,u['id']))
        db.commit()
        return jsonify(success=True,key=key,id=kid,expires=expires,cost=0 if credit=='unlimited' else cost,credit='unlimited' if credit=='unlimited' else None)
    except Exception as e: db.rollback(); return jsonify(error=str(e)),400

@app.post('/api/validate')
@app.get('/api/validate')
@app.post('/api/check')
@app.get('/api/check')
@app.post('/api/license/validate')
@app.get('/api/license/validate')
def validate_license():
    d=request.get_json(silent=True) or request.args
    key=str(d.get('key','')).strip(); device=str(d.get('device_id') or d.get('device') or '').strip()
    if not key or not device: return jsonify(valid=False,status='invalid',message='key dan device_id wajib diisi'),400
    db=conn(); db.execute('BEGIN IMMEDIATE')
    row=db.execute('SELECT * FROM keys WHERE key=?',(key,)).fetchone()
    if not row: db.rollback(); return jsonify(valid=False,status='invalid',message='License tidak ditemukan'),404
    if row['status']!='active': db.rollback(); return jsonify(valid=False,status=row['status'],message='License tidak aktif'),403
    if row['expires']!='PERMANENT' and row['expires']<=now(): db.rollback(); return jsonify(valid=False,status='expired',message='License sudah expired'),403
    ids=json_load(row['device_ids'],[])
    if device not in ids:
        if len(ids)>=int(row['max_devices'] or 1): db.rollback(); return jsonify(valid=False,status='device_limit',message='Batas device tercapai'),403
        ids.append(device); db.execute('UPDATE keys SET device_ids=?,devices=?,updatedAt=? WHERE id=?',(json_dump(ids),len(ids),now(),row['id']))
    db.commit()
    return jsonify(valid=True,status='active',key=row['key'],expires=row['expires'],devices=len(ids),max_devices=row['max_devices'])

@app.post('/api/validate-device')
def validate_device(): return validate_license()

@app.post('/api/setup/owner')
def setup_owner():
    # One-time setup endpoint: requires a secret printed by CLI.
    setup=BASE/'setup.token'
    if not setup.exists(): return jsonify(error='Run: python server.py --setup-token first'),403
    data=request.get_json(silent=True) or {}
    if data.get('setup_token') != setup.read_text().strip(): return jsonify(error='Invalid setup token'),403
    email=str(data.get('email','')).strip().lower(); password=str(data.get('password',''))
    if not email or len(password)<8: return jsonify(error='Valid email and password (8+) required'),400
    db=conn()
    if db.execute("SELECT 1 FROM users WHERE role='owner'").fetchone(): return jsonify(error='Owner already exists'),409
    uid=new_id(); t=now(); db.execute('INSERT INTO users(id,email,password_hash,role,username,status,credit,createdAt,updatedAt) VALUES(?,?,?,?,?,?,?,?,?)',(uid,email,generate_password_hash(password),'owner','Owner','active','1000',t,t)); db.commit(); setup.unlink(missing_ok=True)
    return jsonify(success=True,message='Owner created')

if __name__=='__main__':
    init_db()
    ap=argparse.ArgumentParser(); ap.add_argument('--setup-token',action='store_true'); ap.add_argument('--host',default='0.0.0.0'); ap.add_argument('--port',type=int,default=5000); args=ap.parse_args()
    if args.setup_token:
        p=BASE/'setup.token'; p.write_text(secrets.token_urlsafe(24)); print('SETUP TOKEN:',p.read_text().strip()); raise SystemExit
    print(f'API running on http://{args.host}:{args.port}')
    app.run(host=args.host,port=args.port)
