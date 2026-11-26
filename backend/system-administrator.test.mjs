import assert from "node:assert/strict";
import {createHash, pbkdf2Sync} from "node:crypto";
import {readFile} from "node:fs/promises";
import {test} from "node:test";
import {fileURLToPath} from "node:url";
import {convertV4MiniflareOptions, Miniflare} from "../../tczk-newsletter-api/node_modules/miniflare/dist/src/index.js";

test("P0 bootstrap maintains identity and requires another reauthenticated P0 for protected changes", async () => {
  const service = new Miniflare(convertV4MiniflareOptions({
    modules:true,
    scriptPath:fileURLToPath(new URL("./worker.js",import.meta.url)),
    compatibilityDate:"2026-09-10",
    d1Databases:{DB:"admin-test"},
    bindings:{GALLERY_API_ADMIN_TOKEN:"test-bridge"},
    serviceBindings:{GALLERY_API:request => Response.json({priority:request.headers.get("X-TCZK-Actor-Priority")})}
  }));
  try {
    const db = await service.getD1Database("DB");
    await db.batch([
      "CREATE TABLE admin_users (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL, password_hash TEXT, role TEXT NOT NULL CHECK (role IN ('admin','editor')), active INTEGER NOT NULL CHECK(active IN (0,1)), priority INTEGER NOT NULL CHECK(priority IN (1,2,3)), created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP, last_login_at TEXT, deleted_at TEXT)",
      "CREATE TABLE admin_sessions (id TEXT PRIMARY KEY,user_id INTEGER REFERENCES admin_users(id) ON DELETE CASCADE,token_hash TEXT UNIQUE,expires_at TEXT,last_used_at TEXT)",
      "CREATE TABLE audit_log (id INTEGER PRIMARY KEY,user_id INTEGER REFERENCES admin_users(id) ON DELETE SET NULL,action TEXT,entity_type TEXT,entity_id TEXT,details TEXT,created_at TEXT DEFAULT CURRENT_TIMESTAMP)"
    ].map(sql => db.prepare(sql)));
    const password = "example-local-test-only";
    const salt = Buffer.from("local-test-salt");
    const hash = pbkdf2Sync(password,salt,100000,32,"sha256").toString("base64url");
    const record = ["pbkdf2_sha256","100000",salt.toString("base64url"),hash].join("$");
    for (const [id,email,priority] of [[1,"jackkinn13@gmail.com",1],[2,"p1@example.test",1],[3,"p2@example.test",2],[4,"editor@example.test",3]]) {
      await db.prepare("INSERT INTO admin_users (id,email,display_name,password_hash,role,active,priority) VALUES (?,?,?,?,?,1,?)")
        .bind(id,email,"Local Admin "+id,record,priority===3?"editor":"admin",priority).run();
      const tokenHash = createHash("sha256").update("test-"+id).digest("hex");
      await db.prepare("INSERT INTO admin_sessions (id,user_id,token_hash,expires_at) VALUES (?,?,?,?)")
        .bind(String(id),id,tokenHash,"2099-01-01T00:00:00Z").run();
    }
    for (const migration of ["0001-system-administrator.sql","0002-bootstrap-system-administrator.sql"]) {
      const sql=await readFile(new URL(migration,import.meta.url),"utf8");
      await db.batch(sql.trim().split(/\n[ \t]*\n/).map(statement => db.prepare(statement.trim())));
    }
    const saved = await db.prepare("SELECT id,email,password_hash,priority,system_admin FROM admin_users WHERE id=1").first();
    assert.deepEqual(saved,{id:1,email:"jackkinn13@gmail.com",password_hash:record,priority:1,system_admin:1});
    const request = (path, id, body) => service.dispatchFetch("https://admin.test"+path,{
      method:body===undefined?"GET":"POST",headers:{Authorization:"Bearer test-"+id},body:body===undefined?undefined:JSON.stringify(body)
    });
    const update = (id, fields) => request("/api/admin/users/update",id,fields);
    assert.equal((await (await request("/api/auth/session",1)).json()).user.priority,0);
    assert.equal((await (await request("/api/gallery-v19/manage",1)).json()).priority,"1");
    for (const id of [2,3,4]) assert.equal((await update(id,{userId:1,displayName:"No change"})).status,403);
    assert.equal((await update(1,{userId:1,priority:1,currentPassword:password})).status,403);
    await assert.rejects(db.prepare("UPDATE admin_users SET system_admin=0 WHERE id=1").run(),/last active System Administrator/);
    assert.equal((await update(1,{userId:3,priority:0,currentPassword:"wrong"})).status,403);
    assert.equal((await update(1,{userId:3,priority:0,currentPassword:password})).status,200);
    assert.equal((await request("/api/auth/session",3)).status,401);
    assert.equal((await db.prepare("SELECT count(*) AS total FROM audit_log WHERE action IN ('initial_system_admin_promoted','account_updated')").first()).total,2);
    const login = await request("/api/auth/login",0,{email:"p2@example.test",password});
    const token = (await login.json()).token;
    const protectedUpdate = await service.dispatchFetch("https://admin.test/api/admin/users/update",{
      method:"POST",headers:{Authorization:"Bearer "+token},body:JSON.stringify({userId:1,email:"protected@example.test",currentPassword:password})
    });
    assert.equal(protectedUpdate.status,200);
    assert.equal((await request("/api/auth/session",1)).status,401);
  } finally {
    await service.dispose();
  }
});

test("the newsletter accepts P0 through the normal admin service binding", async () => {
  const root = new URL("../../",import.meta.url);
  const modules = [
    ...["worker","ses","ses-admission","feedback","campaigns","queue"].map(name => ["ESModule",`newsletter-${name}.mjs`]),
    ...["newsletter-footer.html","ThetaChiZetaKappaWebsite/newsletter/subscribe/index.html","ThetaChiZetaKappaWebsite/js/newsletter-subscribe.js"]
      .map(name => ["Text",name]),
  ].map(([type,name]) => ({type,path:fileURLToPath(new URL(name,root))}));
  const service = new Miniflare(convertV4MiniflareOptions({
    modules,
    modulesRoot:fileURLToPath(root),
    compatibilityDate:"2026-11-23",
    compatibilityFlags:["nodejs_compat"],
    d1Databases:{DB:"newsletter-test"},
    serviceBindings:{ADMIN_API:request => {
      const priority = Number(request.headers.get("Authorization").slice(7));
      return Response.json({ok:true,user:{id:1,priority,role:priority===3?"editor":"admin"}});
    }}
  }));
  try {
    const db = await service.getD1Database("DB");
    await db.prepare("CREATE TABLE subscribers (id TEXT,email TEXT,first_name TEXT,last_name TEXT,status TEXT,created_at TEXT,verified_at TEXT)").run();
    for (const priority of [0,1,2,3]) {
      const result = await service.dispatchFetch("https://newsletter.test/api/v1/admin/subscribers",{
        headers:{Authorization:"Bearer "+priority}
      });
      assert.equal(result.status,priority===3?403:200);
    }
  } finally {
    await service.dispose();
  }
});
