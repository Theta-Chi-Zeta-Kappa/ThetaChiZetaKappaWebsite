// TCZK Admin/API Worker v26.1 — check payment + Square amount fixes
import { connect } from "cloudflare:sockets";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "";
    const allowedOrigins = new Set([
  "https://www.tczk.org",
  "https://tczk.org",
  "http://localhost:8000"
]);

    const corsOrigin = allowedOrigins.has(origin) ? origin : "https://www.tczk.org";
    const headers = {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": corsOrigin,
      "Vary": "Origin",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS"
    };

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });

    try {
      if (url.pathname === "/api/health" && request.method === "GET") {
        const dbCheck = await env.DB.prepare("SELECT COUNT(*) AS count FROM gallery_images").first();
        const r2Check = await env.GALLERY.list({ limit: 1 });
        const publicationsCheck=env.Publications?await env.Publications.list({limit:1}):null;
        const historyCheck=env.HISTORY_UPLOADS?await env.HISTORY_UPLOADS.list({limit:1}):null;
        return json({ok:true,worker:"tczk-admin-api",d1:{connected:true,galleryImages:dbCheck?.count??0},r2:{connected:true,sampleObjectCount:r2Check?.objects?.length??0},publications:{connected:Boolean(env.Publications),sampleObjectCount:publicationsCheck?.objects?.length??0},historyUploads:{connected:Boolean(env.HISTORY_UPLOADS),sampleObjectCount:historyCheck?.objects?.length??0}},200,headers);
      }

      if (url.pathname === "/api/auth/login" && request.method === "POST") {
        const body = await safeJson(request);
        if (!body) return json({ok:false,error:"Invalid JSON body."},400,headers);
        const email = normalizeEmail(body.email);
        const password = String(body.password || "");
        if (!email || !password) return json({ok:false,error:"Email and password are required."},400,headers);

        const user = await env.DB.prepare(`SELECT id,email,display_name,password_hash,role,priority,active FROM admin_users WHERE lower(email)=? LIMIT 1`).bind(email).first();
        if (!user || !user.active || !user.password_hash) { await sleep(300); return json({ok:false,error:"Invalid email or password."},401,headers); }
        const valid = await verifyPassword(password,user.password_hash);
        if (!valid) { await sleep(300); return json({ok:false,error:"Invalid email or password."},401,headers); }

        const rawToken=randomToken(32), tokenHash=await sha256Hex(rawToken), sessionId=crypto.randomUUID();
        const expiresAt=new Date(Date.now()+12*60*60*1000).toISOString();
        await env.DB.prepare(`INSERT INTO admin_sessions (id,user_id,token_hash,expires_at) VALUES (?,?,?,?)`).bind(sessionId,user.id,tokenHash,expiresAt).run();
        await env.DB.prepare(`UPDATE admin_users SET last_login_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=?`).bind(user.id).run();
        await writeAudit(env,user.id,"login","admin_user",String(user.id),{email:user.email});
        return json({ok:true,token:rawToken,expiresAt,user:publicUser(user)},200,headers);
      }

      if (url.pathname === "/api/auth/session" && request.method === "GET") {
        const session=await requireSession(request,env);
        if(!session) return json({ok:false,error:"Unauthorized."},401,headers);
        return json({ok:true,user:publicSessionUser(session),expiresAt:session.expires_at},200,headers);
      }

      if (url.pathname === "/api/auth/logout" && request.method === "POST") {
        const auth=bearerToken(request);
        if(auth){const tokenHash=await sha256Hex(auth);await env.DB.prepare("DELETE FROM admin_sessions WHERE token_hash=?").bind(tokenHash).run();}
        return json({ok:true},200,headers);
      }

      // Authenticated dashboard activity feed. Routine login events are omitted so this stays focused on content/system changes.
      if (url.pathname === "/api/admin/activity" && request.method === "GET") {
        const session=await requireSession(request,env);
        if(!session) return json({ok:false,error:"Unauthorized."},401,headers);
        const requested=Number(url.searchParams.get("limit")||10);
        const limit=Math.max(1,Math.min(25,Number.isFinite(requested)?Math.floor(requested):10));
        const result=await env.DB.prepare(`SELECT a.id,a.action,a.entity_type,a.entity_id,a.details,a.created_at,u.email,u.display_name FROM audit_log a LEFT JOIN admin_users u ON u.id=a.user_id WHERE a.action<>'login' ORDER BY datetime(a.created_at) DESC,a.id DESC LIMIT ?`).bind(limit).all();
        const activity=(result.results||[]).map(row=>{
          let details={};
          try{details=row.details?JSON.parse(row.details):{};}catch{}
          return {
            id:row.id,
            action:row.action,
            entityType:row.entity_type,
            entityId:row.entity_id,
            details,
            createdAt:row.created_at,
            userName:row.display_name||null,
            userEmail:row.email||null
          };
        });
        return json({ok:true,activity},200,headers);
      }

      // Public one-time invitation validation. Only non-secret invite metadata is returned.
      if (url.pathname === "/api/auth/invite" && request.method === "GET") {
        const token=String(url.searchParams.get("token")||"").trim();
        if(!token) return json({ok:false,error:"Invitation token is required."},400,headers);
        const invite=await getInviteByToken(env,token);
        if(!invite) return json({ok:false,error:"This setup link is invalid."},404,headers);
        const state=inviteState(invite);
        if(state!=="pending") return json({ok:false,error:state==="expired"?"This setup link has expired.":"This setup link is no longer active."},410,headers);
        return json({ok:true,invite:{email:invite.email,displayName:invite.display_name,role:invite.role,priority:Number(invite.priority)||3,expiresAt:invite.expires_at}},200,headers);
      }

      if (url.pathname === "/api/auth/setup" && request.method === "POST") {
        const body=await safeJson(request);
        if(!body) return json({ok:false,error:"Invalid JSON body."},400,headers);
        const token=String(body.token||"").trim(), password=String(body.password||"");
        if(!token||!password) return json({ok:false,error:"Setup token and password are required."},400,headers);
        const passError=validatePassword(password);
        if(passError) return json({ok:false,error:passError},400,headers);
        const invite=await getInviteByToken(env,token);
        if(!invite) return json({ok:false,error:"This setup link is invalid."},404,headers);
        if(inviteState(invite)!=="pending") return json({ok:false,error:"This setup link has expired or is no longer active."},410,headers);

        const existing=await env.DB.prepare(`SELECT id FROM admin_users WHERE lower(email)=lower(?) LIMIT 1`).bind(invite.email).first();
        if(existing) return json({ok:false,error:"An account already exists for this email. Ask an administrator to reactivate it if needed."},409,headers);

        const passwordHash=await makePasswordRecord(password);
        const create=env.DB.prepare(`INSERT INTO admin_users (email,display_name,password_hash,role,priority,active,created_at,updated_at) VALUES (?,?,?,?,?,1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`).bind(invite.email,invite.display_name,passwordHash,invite.role,Number(invite.priority)||3);
        const consume=env.DB.prepare(`UPDATE admin_invites SET used_at=CURRENT_TIMESTAMP, token_plaintext=NULL WHERE id=? AND used_at IS NULL AND revoked_at IS NULL AND datetime(expires_at)>datetime('now')`).bind(invite.id);
        await env.DB.batch([create,consume]);
        const newUser=await env.DB.prepare(`SELECT id,email,display_name,role,priority,active FROM admin_users WHERE lower(email)=lower(?) LIMIT 1`).bind(invite.email).first();
        await writeAudit(env,newUser?.id||null,"account_activated","admin_user",String(newUser?.id||""),{email:invite.email,role:invite.role,priority:Number(invite.priority)||3,inviteId:invite.id});
        return json({ok:true,message:"Account setup complete. You can now sign in."},200,headers);
      }

      if (url.pathname === "/api/admin/accounts" && request.method === "GET") {
        const admin=await requireAdmin(request,env);
        if(!admin) return json({ok:false,error:"Administrator access required."},403,headers);
        const users=await env.DB.prepare(`SELECT id,email,display_name,role,priority,active,created_at,updated_at,last_login_at FROM admin_users WHERE deleted_at IS NULL ORDER BY active DESC, lower(display_name), lower(email)`).all();
        const invites=await env.DB.prepare(`SELECT id,email,display_name,role,priority,created_by,created_at,expires_at,used_at,revoked_at FROM admin_invites ORDER BY created_at DESC LIMIT 100`).all();
        return json({ok:true,users:(users.results||[]).map(mapUserRow),invites:(invites.results||[]).map(i=>({...mapInviteRow(i),status:inviteState(i)}))},200,headers);
      }

      if (url.pathname === "/api/admin/invites/create" && request.method === "POST") {
        const admin=await requireAdmin(request,env);
        if(!admin) return json({ok:false,error:"Administrator access required."},403,headers);
        const body=await safeJson(request); if(!body) return json({ok:false,error:"Invalid JSON body."},400,headers);
        const email=normalizeEmail(body.email), displayName=String(body.displayName||"").trim(), priority=normalizePriority(body.priority), role=priority===3?"editor":"admin";
        if(!email||!isEmail(email)) return json({ok:false,error:"Enter a valid email address."},400,headers);
        if(displayName.length<2||displayName.length>120) return json({ok:false,error:"Display name must be between 2 and 120 characters."},400,headers);
        if(!priority) return json({ok:false,error:"Access level must be Primary Admin, Secondary Admin, or Editor."},400,headers);
        if(!canManagePriority(admin,priority)) return json({ok:false,error:"Secondary Admins cannot create Primary Admin accounts."},403,headers);
        const existing=await env.DB.prepare(`SELECT id,active FROM admin_users WHERE lower(email)=? LIMIT 1`).bind(email).first();
        if(existing) return json({ok:false,error:existing.active?"An active account already uses this email.":"A disabled account already uses this email. Reactivate that account instead of creating a new invitation."},409,headers);
        const pending=await env.DB.prepare(`SELECT id FROM admin_invites WHERE lower(email)=? AND used_at IS NULL AND revoked_at IS NULL AND datetime(expires_at)>datetime('now') LIMIT 1`).bind(email).first();
        if(pending) return json({ok:false,error:"A pending invitation already exists for this email. Revoke it before creating another."},409,headers);

        const rawToken=randomToken(32), tokenHash=await sha256Hex(rawToken), id=crypto.randomUUID();
        const expiresAt=new Date(Date.now()+72*60*60*1000).toISOString();
        await env.DB.prepare(`INSERT INTO admin_invites (id,email,display_name,token_hash,token_plaintext,role,priority,created_by,created_at,expires_at) VALUES (?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP,?)`).bind(id,email,displayName,tokenHash,rawToken,role,priority,admin.user_id,expiresAt).run();
        await writeAudit(env,admin.user_id,"invite_created","admin_invite",id,{email,displayName,role,priority,expiresAt});
        const setupUrl=`https://www.tczk.org/admin/setup/?token=${encodeURIComponent(rawToken)}`;
        const mail=await sendTransactionalEmail(env,{
          to:[email],
          subject:"Your TCZK Admin invitation",
          text:`${displayName},\n\nYou've been invited to TCZK Admin as ${accessLabel(priority)}.\n\nSet up your account: ${setupUrl}\n\nThis one-time link expires in 72 hours. If you were not expecting this invitation, you can ignore this email.`,
          html:adminEmailTemplate("You're invited to TCZK Admin",`<p>Hello ${escapeHtml(displayName)},</p><p>You've been invited to help manage the Zeta Kappa Chapter website as <strong>${escapeHtml(accessLabel(priority))}</strong>.</p>${emailButton("Set Up Your Account",setupUrl)}<p class="muted">This one-time link expires in 72 hours. If you were not expecting this invitation, you can ignore this email.</p>`)
        },{category:"account_invitation",entityType:"admin_invite",entityId:id,actorUserId:admin.user_id});
        return json({ok:true,invite:{id,email,displayName,role,priority,expiresAt},token:rawToken,setupUrl,emailSent:mail.ok,emailError:mail.ok?null:mail.error},201,headers);
      }

      if (url.pathname === "/api/admin/invites/link" && request.method === "POST") {
        const admin=await requireAdmin(request,env);
        if(!admin) return json({ok:false,error:"Administrator access required."},403,headers);
        const body=await safeJson(request); if(!body) return json({ok:false,error:"Invalid JSON body."},400,headers);
        const inviteId=String(body.inviteId||"").trim();
        const invite=await env.DB.prepare(`SELECT id,email,priority,expires_at,used_at,revoked_at,token_plaintext FROM admin_invites WHERE id=? LIMIT 1`).bind(inviteId).first();
        if(!invite) return json({ok:false,error:"Invitation not found."},404,headers);
        if(!canManagePriority(admin,Number(invite.priority)||3)) return json({ok:false,error:"Secondary Admins cannot view Primary Admin invitation links."},403,headers);
        if(inviteState(invite)!=="pending") return json({ok:false,error:"Only active pending invitation links can be viewed."},409,headers);
        if(!invite.token_plaintext) return json({ok:false,error:"This invitation was created before saved-link recovery was enabled. Revoke it and create a new invitation if a replacement link is needed."},409,headers);
        const setupUrl=`https://www.tczk.org/admin/setup/?token=${encodeURIComponent(invite.token_plaintext)}`;
        await writeAudit(env,admin.user_id,"invite_link_viewed","admin_invite",invite.id,{email:invite.email});
        return json({ok:true,setupUrl,expiresAt:invite.expires_at,email:invite.email},200,headers);
      }

      if (url.pathname === "/api/admin/invites/revoke" && request.method === "POST") {
        const admin=await requireAdmin(request,env);
        if(!admin) return json({ok:false,error:"Administrator access required."},403,headers);
        const body=await safeJson(request); if(!body) return json({ok:false,error:"Invalid JSON body."},400,headers);
        const inviteId=String(body.inviteId||"").trim();
        const invite=await env.DB.prepare(`SELECT id,email,priority,used_at,revoked_at FROM admin_invites WHERE id=? LIMIT 1`).bind(inviteId).first();
        if(!invite) return json({ok:false,error:"Invitation not found."},404,headers);
        if(!canManagePriority(admin,Number(invite.priority)||3)) return json({ok:false,error:"Secondary Admins cannot manage Primary Admin invitations."},403,headers);
        if(invite.used_at) return json({ok:false,error:"Activated invitations cannot be revoked."},409,headers);
        if(!invite.revoked_at) await env.DB.prepare(`UPDATE admin_invites SET revoked_at=CURRENT_TIMESTAMP, token_plaintext=NULL WHERE id=?`).bind(inviteId).run();
        await writeAudit(env,admin.user_id,"invite_revoked","admin_invite",inviteId,{email:invite.email});
        return json({ok:true},200,headers);
      }

      if (url.pathname === "/api/admin/invites/delete" && request.method === "POST") {
        const admin=await requireAdmin(request,env);
        if(!admin) return json({ok:false,error:"Administrator access required."},403,headers);
        const body=await safeJson(request);if(!body)return json({ok:false,error:"Invalid JSON body."},400,headers);
        const inviteId=String(body.inviteId||"").trim();
        const invite=await env.DB.prepare(`SELECT id,email,priority,expires_at,used_at,revoked_at FROM admin_invites WHERE id=? LIMIT 1`).bind(inviteId).first();
        if(!invite)return json({ok:false,error:"Invitation not found."},404,headers);
        if(!canManagePriority(admin,Number(invite.priority)||3)) return json({ok:false,error:"Secondary Admins cannot manage Primary Admin invitations."},403,headers);
        const state=inviteState(invite);
        if(!["revoked","expired"].includes(state))return json({ok:false,error:"Only revoked or expired invitations can be deleted."},409,headers);
        await env.DB.prepare(`DELETE FROM admin_invites WHERE id=?`).bind(inviteId).run();
        await writeAudit(env,admin.user_id,"invite_deleted","admin_invite",inviteId,{email:invite.email,previousStatus:state});
        return json({ok:true,deleted:true,id:inviteId},200,headers);
      }

      if (url.pathname === "/api/admin/users/update" && request.method === "POST") {
        const admin=await requireAdmin(request,env);
        if(!admin) return json({ok:false,error:"Administrator access required."},403,headers);
        const body=await safeJson(request); if(!body) return json({ok:false,error:"Invalid JSON body."},400,headers);
        const userId=Number(body.userId);
        if(!Number.isInteger(userId)||userId<=0) return json({ok:false,error:"A valid user ID is required."},400,headers);
        const target=await env.DB.prepare(`SELECT id,email,display_name,role,priority,active FROM admin_users WHERE id=? LIMIT 1`).bind(userId).first();
        if(!target) return json({ok:false,error:"Account not found."},404,headers);
        const displayName=body.displayName===undefined?target.display_name:String(body.displayName||"").trim();
        const priority=body.priority===undefined?(Number(target.priority)||3):normalizePriority(body.priority);
        const role=priority===3?"editor":"admin";
        const active=body.active===undefined?Number(target.active):body.active?1:0;
        if(displayName.length<2||displayName.length>120) return json({ok:false,error:"Display name must be between 2 and 120 characters."},400,headers);
        if(!priority) return json({ok:false,error:"Access level must be Primary Admin, Secondary Admin, or Editor."},400,headers);
        if(!canManagePriority(admin,Number(target.priority)||3) || !canManagePriority(admin,priority)) return json({ok:false,error:"Secondary Admins cannot manage or assign Primary Admin access."},403,headers);

        const removingPrimary = Number(target.active)===1 && Number(target.priority)===1 && (active===0 || priority!==1);
        if(removingPrimary){
          const count=await env.DB.prepare(`SELECT COUNT(*) AS count FROM admin_users WHERE active=1 AND priority=1 AND id<>?`).bind(userId).first();
          if(Number(count?.count||0)<1) return json({ok:false,error:"You cannot disable or demote the last active Primary Admin account."},409,headers);
        }

        const removingAdmin = Number(target.active)===1 && target.role==="admin" && (active===0 || role!=="admin");
        if(removingAdmin){
          const count=await env.DB.prepare(`SELECT COUNT(*) AS count FROM admin_users WHERE active=1 AND role='admin' AND id<>?`).bind(userId).first();
          if(Number(count?.count||0)<1) return json({ok:false,error:"You cannot disable or demote the last active Admin account."},409,headers);
        }

        await env.DB.prepare(`UPDATE admin_users SET display_name=?,role=?,priority=?,active=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`).bind(displayName,role,priority,active,userId).run();
        if(active===0) await env.DB.prepare(`DELETE FROM admin_sessions WHERE user_id=?`).bind(userId).run();
        await writeAudit(env,admin.user_id,"account_updated","admin_user",String(userId),{email:target.email,displayName,role,priority,active:Boolean(active)});
        return json({ok:true,user:{id:userId,email:target.email,displayName,role,priority,active:Boolean(active)}},200,headers);
      }


      if (url.pathname === "/api/admin/users/delete" && request.method === "POST") {
        const admin=await requireAdmin(request,env);
        if(!admin) return json({ok:false,error:"Administrator access required."},403,headers);
        const body=await safeJson(request); if(!body) return json({ok:false,error:"Invalid JSON body."},400,headers);
        const userId=Number(body.userId);
        if(!Number.isInteger(userId)||userId<=0) return json({ok:false,error:"A valid user ID is required."},400,headers);
        if(Number(admin.user_id)===userId) return json({ok:false,error:"You cannot permanently delete your own account."},409,headers);
        const target=await env.DB.prepare(`SELECT id,email,display_name,role,priority,active FROM admin_users WHERE id=? LIMIT 1`).bind(userId).first();
        if(!target) return json({ok:false,error:"Account not found."},404,headers);
        if(Number(target.active)===1) return json({ok:false,error:"Archive the account before permanently deleting it."},409,headers);
        if(!canManagePriority(admin,Number(target.priority)||3)) return json({ok:false,error:"Secondary Admins cannot delete Primary Admin accounts."},403,headers);

        // Preserve the numeric user row as a tombstone because historical content, gallery,
        // invitation, email, and audit records may still reference this user ID through foreign keys.
        // The original email is released immediately so the person can receive a brand-new invitation later.
        await writeAudit(env,admin.user_id,"account_deleted","admin_user",String(userId),{email:target.email,displayName:target.display_name,role:target.role,priority:Number(target.priority)||3});
        await env.DB.prepare(`DELETE FROM admin_sessions WHERE user_id=?`).bind(userId).run();
        const deletedEmail=`deleted-${userId}-${crypto.randomUUID()}@deleted.invalid`;
        const deadPassword=`deleted:${crypto.randomUUID()}:${crypto.randomUUID()}`;
        await env.DB.prepare(`UPDATE admin_users SET email=?,display_name='Deleted account',password_hash=?,active=0,deleted_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=? AND active=0`).bind(deletedEmail,deadPassword,userId).run();
        return json({ok:true,deleted:true,id:userId,email:target.email},200,headers);
      }

      if (url.pathname === "/api/admin/email/test" && request.method === "POST") {
        const admin=await requirePrimaryAdmin(request,env);
        if(!admin) return json({ok:false,error:"Primary Admin access required."},403,headers);
        const result=await sendTransactionalEmail(env,{
          to:[admin.email],subject:"TCZK Admin email test",
          text:"Your TCZK Admin transactional email connection through Purelymail is working.",
          html:adminEmailTemplate("Email test successful",`<p>Your TCZK Admin transactional email connection through <strong>admin@tczk.org</strong> is working.</p>`)
        },{category:"system_test",entityType:"admin_user",entityId:String(admin.user_id),actorUserId:admin.user_id});
        return json({ok:result.ok,error:result.ok?null:result.error},result.ok?200:502,headers);
      }



      // Phase 3: unified Blog / Newsletter publishing workflow.
      if (url.pathname === "/api/content/stats" && request.method === "GET") {
        const session=await requireSession(request,env);
        if(!session) return json({ok:false,error:"Unauthorized."},401,headers);
        const rows=(await env.DB.prepare(`SELECT type,status,COUNT(*) AS count FROM content_posts GROUP BY type,status`).all()).results||[];
        const stats={blog:0,newsletter:0,draft:0,submitted:0,changes_requested:0,published:0,archived:0,rejected:0,total:0};
        for(const r of rows){const n=Number(r.count)||0;stats.total+=n;if(r.type==="blog")stats.blog+=n;if(r.type==="newsletter")stats.newsletter+=n;if(Object.prototype.hasOwnProperty.call(stats,r.status))stats[r.status]+=n;}
        return json({ok:true,stats},200,headers);
      }

      if (url.pathname === "/api/content/posts" && request.method === "GET") {
        const session=await requireSession(request,env);
        if(!session) return json({ok:false,error:"Unauthorized."},401,headers);
        const type=normalizeContentType(url.searchParams.get("type"));
        const status=normalizeContentStatus(url.searchParams.get("status"));
        const clauses=[],bind=[];
        if(type){clauses.push("p.type=?");bind.push(type);}
        if(status){clauses.push("p.status=?");bind.push(status);}
        const where=clauses.length?`WHERE ${clauses.join(" AND ")}`:"";
        const q=`SELECT p.*,u.display_name AS creator_name,u.email AS creator_email,s.display_name AS submitter_name,a.display_name AS approver_name FROM content_posts p LEFT JOIN admin_users u ON u.id=p.created_by LEFT JOIN admin_users s ON s.id=p.submitted_by LEFT JOIN admin_users a ON a.id=p.approved_by ${where} ORDER BY CASE p.status WHEN 'submitted' THEN 0 WHEN 'changes_requested' THEN 1 WHEN 'draft' THEN 2 WHEN 'published' THEN 3 ELSE 4 END, COALESCE(p.publication_date,p.updated_at) DESC, p.updated_at DESC LIMIT 500`;
        const stmt=env.DB.prepare(q);
        const rows=(await (bind.length?stmt.bind(...bind):stmt).all()).results||[];
        return json({ok:true,posts:rows.map(mapContentPost)},200,headers);
      }

      if (url.pathname === "/api/content/post" && request.method === "GET") {
        const session=await requireSession(request,env);
        if(!session) return json({ok:false,error:"Unauthorized."},401,headers);
        const id=String(url.searchParams.get("id")||"").trim();
        const row=await getContentPostRow(env,id);
        if(!row) return json({ok:false,error:"Post not found."},404,headers);
        const assets=(await env.DB.prepare(`SELECT ca.*,u.display_name AS uploader_name,u.email AS uploader_email FROM content_assets ca LEFT JOIN admin_users u ON u.id=ca.uploaded_by WHERE ca.post_id=? ORDER BY ca.kind,ca.version DESC,ca.created_at DESC`).bind(id).all()).results||[];
        return json({ok:true,post:mapContentPost(row),assets:assets.map(mapContentAsset)},200,headers);
      }

      if (url.pathname === "/api/content/posts/create" && request.method === "POST") {
        const session=await requireSession(request,env);
        if(!session) return json({ok:false,error:"Unauthorized."},401,headers);
        const body=await safeJson(request);
        if(!body) return json({ok:false,error:"Invalid JSON body."},400,headers);
        const clean=cleanContentPost(body);
        if(clean.error) return json({ok:false,error:clean.error},400,headers);
        const exists=await env.DB.prepare(`SELECT id FROM content_posts WHERE lower(slug)=lower(?) LIMIT 1`).bind(clean.slug).first();
        if(exists) return json({ok:false,error:"That URL slug is already in use."},409,headers);
        const id=crypto.randomUUID();
        await env.DB.prepare(`INSERT INTO content_posts (id,type,slug,title,summary,author_name,author_image_url,categories_json,season,year,publication_date,status,featured,current_newsletter,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,'draft',?,?,?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`).bind(id,clean.type,clean.slug,clean.title,clean.summary,clean.authorName,clean.authorImageUrl,JSON.stringify(clean.categories),clean.season,clean.year,clean.publicationDate,clean.featured?1:0,clean.currentNewsletter?1:0,session.user_id).run();
        await writeAudit(env,session.user_id,"content_draft_created","content_post",id,{type:clean.type,title:clean.title,slug:clean.slug});
        return json({ok:true,post:mapContentPost(await getContentPostRow(env,id))},201,headers);
      }

      if (url.pathname === "/api/content/posts/update" && request.method === "POST") {
        const session=await requireSession(request,env);
        if(!session) return json({ok:false,error:"Unauthorized."},401,headers);
        const body=await safeJson(request);
        if(!body) return json({ok:false,error:"Invalid JSON body."},400,headers);
        const id=String(body.id||"").trim();
        const current=await env.DB.prepare(`SELECT * FROM content_posts WHERE id=? LIMIT 1`).bind(id).first();
        if(!current) return json({ok:false,error:"Post not found."},404,headers);
        const publishedEdit=current.status==="published";
        if(!["draft","changes_requested","published"].includes(current.status)) return json({ok:false,error:"Only drafts, returned posts, or published posts can be edited."},409,headers);
        if(publishedEdit&&session.role!=="admin") return json({ok:false,error:"Only Admins can edit published publications."},403,headers);
        if(!publishedEdit&&session.role!=="admin"&&Number(current.created_by)!==Number(session.user_id)) return json({ok:false,error:"Editors can only modify drafts they created."},403,headers);
        const clean=cleanContentPost({...mapContentPost(current),...body});
        if(clean.error) return json({ok:false,error:clean.error},400,headers);
        const exists=await env.DB.prepare(`SELECT id FROM content_posts WHERE lower(slug)=lower(?) AND id<>? LIMIT 1`).bind(clean.slug,id).first();
        if(exists) return json({ok:false,error:"That URL slug is already in use."},409,headers);
        if(publishedEdit&&clean.currentNewsletter){
          await env.DB.batch([
            env.DB.prepare(`UPDATE content_posts SET current_newsletter=0,updated_at=CURRENT_TIMESTAMP WHERE type='newsletter' AND id<>? AND current_newsletter=1`).bind(id),
            env.DB.prepare(`UPDATE content_posts SET type=?,slug=?,title=?,summary=?,author_name=?,author_image_url=?,categories_json=?,season=?,year=?,publication_date=?,featured=?,current_newsletter=?,review_note=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=?`).bind(clean.type,clean.slug,clean.title,clean.summary,clean.authorName,clean.authorImageUrl,JSON.stringify(clean.categories),clean.season,clean.year,clean.publicationDate,clean.featured?1:0,clean.currentNewsletter?1:0,id)
          ]);
        }else{
          await env.DB.prepare(`UPDATE content_posts SET type=?,slug=?,title=?,summary=?,author_name=?,author_image_url=?,categories_json=?,season=?,year=?,publication_date=?,featured=?,current_newsletter=?,review_note=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=?`).bind(clean.type,clean.slug,clean.title,clean.summary,clean.authorName,clean.authorImageUrl,JSON.stringify(clean.categories),clean.season,clean.year,clean.publicationDate,clean.featured?1:0,clean.currentNewsletter?1:0,id).run();
        }
        await writeAudit(env,session.user_id,publishedEdit?"content_published_updated":"content_draft_updated","content_post",id,{type:clean.type,title:clean.title,slug:clean.slug,featured:clean.featured,currentNewsletter:clean.currentNewsletter});
        return json({ok:true,post:mapContentPost(await getContentPostRow(env,id))},200,headers);
      }

      if (url.pathname === "/api/content/assets/upload" && request.method === "POST") {
        const session=await requireSession(request,env);
        if(!session) return json({ok:false,error:"Unauthorized."},401,headers);
        if(!env.Publications) return json({ok:false,error:"Publications R2 binding is not configured."},500,headers);
        const postId=String(url.searchParams.get("postId")||"").trim(), kind=String(url.searchParams.get("kind")||"").trim().toLowerCase();
        const filename=safePublicationFilename(url.searchParams.get("filename")||"");
        if(!postId||!["pdf","cover"].includes(kind)||!filename) return json({ok:false,error:"postId, kind and filename are required."},400,headers);
        const post=await env.DB.prepare(`SELECT * FROM content_posts WHERE id=? LIMIT 1`).bind(postId).first();
        if(!post) return json({ok:false,error:"Post not found."},404,headers);
        if(!["draft","changes_requested"].includes(post.status)) return json({ok:false,error:"Files can only be changed on drafts or returned posts."},409,headers);
        if(session.role!=="admin"&&Number(post.created_by)!==Number(session.user_id)) return json({ok:false,error:"Editors can only upload files to drafts they created."},403,headers);
        const contentType=String(request.headers.get("Content-Type")||"").split(";")[0].trim().toLowerCase();
        const ext=filename.toLowerCase().split(".").pop();
        if(kind==="pdf" && !(contentType==="application/pdf"||ext==="pdf")) return json({ok:false,error:"The publication file must be a PDF."},415,headers);
        if(kind==="cover" && !(["image/jpeg","image/png","image/webp"].includes(contentType)||["jpg","jpeg","png","webp"].includes(ext))) return json({ok:false,error:"Cover images must be JPEG, PNG, or WebP."},415,headers);
        const buf=await request.arrayBuffer(), size=buf.byteLength;
        const limit=kind==="pdf"?25*1024*1024:10*1024*1024;
        if(!size) return json({ok:false,error:"The uploaded file is empty."},400,headers);
        if(size>limit) return json({ok:false,error:`${kind==="pdf"?"PDF":"Cover"} files are limited to ${Math.round(limit/1024/1024)} MB.`},413,headers);
        const hash=await sha256HexBytes(buf), id=crypto.randomUUID();
        const prior=await env.DB.prepare(`SELECT id,storage_key FROM content_assets WHERE post_id=? AND kind=? AND status='staged'`).bind(postId,kind).all();
        const versionRow=await env.DB.prepare(`SELECT COALESCE(MAX(version),0)+1 AS next_version FROM content_assets WHERE post_id=? AND kind=?`).bind(postId,kind).first();
        const version=Number(versionRow?.next_version)||1, key=`staging/${postId}/${kind}/${id}-${filename}`;
        await env.Publications.put(key,buf,{httpMetadata:{contentType:contentType||guessPublicationContentType(filename)},customMetadata:{postId,kind,sha256:hash,originalName:filename}});
        const statements=[env.DB.prepare(`INSERT INTO content_assets (id,post_id,kind,version,storage_key,original_name,content_type,size_bytes,sha256,status,uploaded_by,created_at) VALUES (?,?,?,?,?,?,?,?,?,'staged',?,CURRENT_TIMESTAMP)`).bind(id,postId,kind,version,key,filename,contentType||guessPublicationContentType(filename),size,hash,session.user_id)];
        for(const a of prior.results||[]) statements.push(env.DB.prepare(`UPDATE content_assets SET status='superseded' WHERE id=?`).bind(a.id));
        await env.DB.batch(statements);
        for(const a of prior.results||[]){try{await env.Publications.delete(a.storage_key);}catch{}}
        await writeAudit(env,session.user_id,"content_asset_uploaded","content_post",postId,{kind,filename,sizeBytes:size,sha256:hash,version});
        const row=await env.DB.prepare(`SELECT * FROM content_assets WHERE id=?`).bind(id).first();
        return json({ok:true,asset:mapContentAsset(row)},201,headers);
      }

      if (url.pathname === "/api/content/assets/preview" && request.method === "GET") {
        const session=await requireSession(request,env);
        if(!session) return json({ok:false,error:"Unauthorized."},401,headers);
        if(!env.Publications) return json({ok:false,error:"Publications R2 binding is not configured."},500,headers);
        const assetId=String(url.searchParams.get("id")||"").trim();
        const asset=await env.DB.prepare(`SELECT ca.*,p.created_by,p.status AS post_status FROM content_assets ca JOIN content_posts p ON p.id=ca.post_id WHERE ca.id=? LIMIT 1`).bind(assetId).first();
        if(!asset) return json({ok:false,error:"Asset not found."},404,headers);
        if(session.role!=="admin"&&Number(asset.created_by)!==Number(session.user_id)) return json({ok:false,error:"Access denied."},403,headers);
        const obj=await env.Publications.get(asset.storage_key);if(!obj)return json({ok:false,error:"File not found in R2."},404,headers);
        return publicationObjectResponse(obj,asset.content_type,asset.original_name,corsOrigin,false);
      }

      if (url.pathname === "/api/content/posts/submit" && request.method === "POST") {
        const session=await requireSession(request,env);
        if(!session) return json({ok:false,error:"Unauthorized."},401,headers);
        const body=await safeJson(request);const id=String(body?.id||"").trim();
        const post=await env.DB.prepare(`SELECT * FROM content_posts WHERE id=? LIMIT 1`).bind(id).first();
        if(!post) return json({ok:false,error:"Post not found."},404,headers);
        if(!["draft","changes_requested"].includes(post.status)) return json({ok:false,error:"Only drafts or returned posts can be submitted."},409,headers);
        if(session.role!=="admin"&&Number(post.created_by)!==Number(session.user_id)) return json({ok:false,error:"Editors can only submit drafts they created."},403,headers);
        if(!post.publication_date) return json({ok:false,error:"Set a publication date before submitting."},400,headers);
        const staged=await getCurrentContentAssets(env,id,"staged");
        const published=await getCurrentContentAssets(env,id,"published");
        if(!staged.pdf&&!published.pdf) return json({ok:false,error:"Upload a PDF before submitting."},400,headers);
        if(!staged.cover&&!published.cover) return json({ok:false,error:"Upload a cover image before submitting."},400,headers);
        await env.DB.prepare(`UPDATE content_posts SET status='submitted',submitted_by=?,submitted_at=CURRENT_TIMESTAMP,review_note=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=?`).bind(session.user_id,id).run();
        await writeAudit(env,session.user_id,"content_submitted","content_post",id,{title:post.title,type:post.type});
        const submittedPost=mapContentPost(await getContentPostRow(env,id));
        await notifyAdminGroup(env,"approval_required",{
          subject:`Approval required: ${post.title}`,
          heading:"Content awaiting approval",
          bodyHtml:`<p><strong>${escapeHtml(session.display_name||session.email)}</strong> submitted a ${escapeHtml(post.type)} for approval.</p><p><strong>${escapeHtml(post.title)}</strong></p>${emailButton("Review Content","https://www.tczk.org/admin/content/approvals/")}`,
          text:`${session.display_name||session.email} submitted ${post.title} for approval. Review: https://www.tczk.org/admin/content/approvals/`,
          entityType:"content_post",entityId:id,actorUserId:session.user_id
        });
        return json({ok:true,post:submittedPost},200,headers);
      }

      if (url.pathname === "/api/content/posts/return" && request.method === "POST") {
        const admin=await requireAdmin(request,env);if(!admin)return json({ok:false,error:"Administrator access required."},403,headers);
        const body=await safeJson(request),id=String(body?.id||"").trim(),note=String(body?.note||"").trim().slice(0,2000);
        if(!note)return json({ok:false,error:"A return note is required."},400,headers);
        const post=await env.DB.prepare(`SELECT * FROM content_posts WHERE id=? AND status='submitted' LIMIT 1`).bind(id).first();if(!post)return json({ok:false,error:"Awaiting-approval post not found."},404,headers);
        await env.DB.prepare(`UPDATE content_posts SET status='changes_requested',review_note=?,approved_by=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`).bind(note,admin.user_id,id).run();
        await writeAudit(env,admin.user_id,"content_changes_requested","content_post",id,{note,title:post.title});
        await notifyUserById(env,post.submitted_by||post.created_by,{
          subject:`Changes requested: ${post.title}`,heading:"Changes requested",
          bodyHtml:`<p>Your submission <strong>${escapeHtml(post.title)}</strong> was reviewed and needs changes before it can be published.</p><p><strong>Reviewer note:</strong></p><p>${escapeHtml(note)}</p>${emailButton("Open Admin Portal","https://www.tczk.org/admin/content/")}`,
          text:`Changes were requested for ${post.title}. Reviewer note: ${note} Open: https://www.tczk.org/admin/content/`,
          category:"submission_changes_requested",entityType:"content_post",entityId:id,actorUserId:admin.user_id
        });
        return json({ok:true},200,headers);
      }

      if (url.pathname === "/api/content/posts/reject" && request.method === "POST") {
        const admin=await requireAdmin(request,env);if(!admin)return json({ok:false,error:"Administrator access required."},403,headers);
        const body=await safeJson(request),id=String(body?.id||"").trim(),note=String(body?.note||"").trim().slice(0,2000);
        if(!note)return json({ok:false,error:"A rejection note is required."},400,headers);
        const post=await env.DB.prepare(`SELECT * FROM content_posts WHERE id=? AND status='submitted' LIMIT 1`).bind(id).first();if(!post)return json({ok:false,error:"Awaiting-approval post not found."},404,headers);
        await env.DB.prepare(`UPDATE content_posts SET status='rejected',review_note=?,approved_by=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`).bind(note,admin.user_id,id).run();
        await env.DB.prepare(`UPDATE content_assets SET status='rejected' WHERE post_id=? AND status='staged'`).bind(id).run();
        await writeAudit(env,admin.user_id,"content_rejected","content_post",id,{note,title:post.title});
        await notifyUserById(env,post.submitted_by||post.created_by,{
          subject:`Submission rejected: ${post.title}`,heading:"Submission rejected",
          bodyHtml:`<p>Your submission <strong>${escapeHtml(post.title)}</strong> was rejected.</p><p><strong>Reviewer note:</strong></p><p>${escapeHtml(note)}</p>${emailButton("Open Admin Portal","https://www.tczk.org/admin/content/")}`,
          text:`${post.title} was rejected. Reviewer note: ${note} Open: https://www.tczk.org/admin/content/`,
          category:"submission_rejected",entityType:"content_post",entityId:id,actorUserId:admin.user_id
        });
        return json({ok:true},200,headers);
      }

      if (url.pathname === "/api/content/posts/publish" && request.method === "POST") {
        const admin=await requireAdmin(request,env);if(!admin)return json({ok:false,error:"Administrator access required."},403,headers);
        if(!env.Publications)return json({ok:false,error:"Publications R2 binding is not configured."},500,headers);
        const body=await safeJson(request),id=String(body?.id||"").trim();
        const post=await env.DB.prepare(`SELECT * FROM content_posts WHERE id=? AND status='submitted' LIMIT 1`).bind(id).first();if(!post)return json({ok:false,error:"Awaiting-approval post not found."},404,headers);
        const staged=await getCurrentContentAssets(env,id,"staged"),published=await getCurrentContentAssets(env,id,"published");
        if(!staged.pdf&&!published.pdf)return json({ok:false,error:"This post has no PDF to publish."},409,headers);
        if(!staged.cover&&!published.cover)return json({ok:false,error:"This post has no cover image to publish."},409,headers);
        const promoted=[];
        try{
          for(const kind of ["pdf","cover"]){const asset=staged[kind];if(!asset)continue;const obj=await env.Publications.get(asset.storage_key);if(!obj)throw new Error(`${kind} staging file is missing from R2.`);const ext=publicationExtension(asset.original_name,asset.content_type,kind);const folder=kind==="pdf"?`publications/${post.type}`:`covers/${post.type}`;const finalKey=`${folder}/${post.slug}-v${asset.version}-${asset.sha256.slice(0,12)}.${ext}`;const exists=await env.Publications.head(finalKey);if(exists)throw new Error(`Refusing to overwrite existing R2 object: ${finalKey}`);await env.Publications.put(finalKey,obj.body,{httpMetadata:{contentType:asset.content_type},customMetadata:{postId:id,kind,sha256:asset.sha256,originalName:asset.original_name}});promoted.push({...asset,finalKey});}
          const statements=[];
          for(const p of promoted){statements.push(env.DB.prepare(`UPDATE content_assets SET status='superseded' WHERE post_id=? AND kind=? AND status='published'`).bind(id,p.kind));statements.push(env.DB.prepare(`UPDATE content_assets SET status='published',storage_key=?,published_at=CURRENT_TIMESTAMP WHERE id=?`).bind(p.finalKey,p.id));}
          const pdfKey=(promoted.find(x=>x.kind==="pdf")?.finalKey)||post.pdf_key||published.pdf?.storage_key||null;
          const coverKey=(promoted.find(x=>x.kind==="cover")?.finalKey)||post.cover_key||published.cover?.storage_key||null;
          if(post.type==="newsletter"&&Number(post.current_newsletter)===1)statements.push(env.DB.prepare(`UPDATE content_posts SET current_newsletter=0,updated_at=CURRENT_TIMESTAMP WHERE type='newsletter' AND status='published' AND id<>?`).bind(id));
          statements.push(env.DB.prepare(`UPDATE content_posts SET pdf_key=?,cover_key=?,status='published',approved_by=?,review_note=NULL,published_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=?`).bind(pdfKey,coverKey,admin.user_id,id));
          await env.DB.batch(statements);
          for(const p of promoted){try{await env.Publications.delete(p.storage_key);}catch{}}
          await writeAudit(env,admin.user_id,"content_published","content_post",id,{title:post.title,type:post.type,featured:Boolean(post.featured),currentNewsletter:Boolean(post.current_newsletter),pdfUpdated:Boolean(staged.pdf),coverUpdated:Boolean(staged.cover)});
          return json({ok:true,post:mapContentPost(await getContentPostRow(env,id))},200,headers);
        }catch(e){for(const p of promoted){try{await env.Publications.delete(p.finalKey);}catch{}}throw e;}
      }

      if (url.pathname === "/api/content/posts/archive" && request.method === "POST") {
        const admin=await requireAdmin(request,env);if(!admin)return json({ok:false,error:"Administrator access required."},403,headers);
        const body=await safeJson(request),id=String(body?.id||"").trim();
        const post=await env.DB.prepare(`SELECT * FROM content_posts WHERE id=? AND status='published' LIMIT 1`).bind(id).first();if(!post)return json({ok:false,error:"Published post not found."},404,headers);
        await env.DB.prepare(`UPDATE content_posts SET status='archived',featured=0,current_newsletter=0,archived_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=?`).bind(id).run();
        await writeAudit(env,admin.user_id,"content_archived","content_post",id,{title:post.title,type:post.type,wasFeatured:Boolean(post.featured),wasCurrentNewsletter:Boolean(post.current_newsletter)});return json({ok:true,status:"archived"},200,headers);
      }

      if (url.pathname === "/api/content/posts/restore" && request.method === "POST") {
        const admin=await requireAdmin(request,env);if(!admin)return json({ok:false,error:"Administrator access required."},403,headers);
        const body=await safeJson(request),id=String(body?.id||"").trim();
        const post=await env.DB.prepare(`SELECT * FROM content_posts WHERE id=? AND status='archived' LIMIT 1`).bind(id).first();if(!post)return json({ok:false,error:"Archived post not found."},404,headers);
        await env.DB.prepare(`UPDATE content_posts SET status='published',featured=0,current_newsletter=0,archived_at=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=?`).bind(id).run();
        await writeAudit(env,admin.user_id,"content_restored","content_post",id,{title:post.title,type:post.type});return json({ok:true,status:"published"},200,headers);
      }

      if (url.pathname === "/api/content/posts/delete-rejected" && request.method === "POST") {
        const admin=await requireAdmin(request,env);if(!admin)return json({ok:false,error:"Administrator access required."},403,headers);
        if(!env.Publications)return json({ok:false,error:"Publications R2 binding is not configured."},500,headers);
        const body=await safeJson(request),id=String(body?.id||"").trim(),confirmSlug=String(body?.confirmSlug||"").trim();
        const post=await env.DB.prepare(`SELECT * FROM content_posts WHERE id=? AND status='rejected' LIMIT 1`).bind(id).first();
        if(!post)return json({ok:false,error:"Rejected publication not found."},404,headers);
        if(confirmSlug!==post.slug)return json({ok:false,error:"Confirmation slug does not match."},400,headers);
        const assets=(await env.DB.prepare(`SELECT id,storage_key,status,kind FROM content_assets WHERE post_id=?`).bind(id).all()).results||[];
        const keys=new Set();
        for(const asset of assets){if(asset.storage_key)keys.add(String(asset.storage_key));}
        if(post.pdf_key)keys.add(String(post.pdf_key));
        if(post.cover_key)keys.add(String(post.cover_key));
        const allowedPrefixes=[`staging/${id}/`,`publications/${post.type}/`,`covers/${post.type}/`];
        const safeKeys=[...keys].filter(key=>allowedPrefixes.some(prefix=>key.startsWith(prefix)));
        if(safeKeys.length!==keys.size)return json({ok:false,error:"Deletion stopped because one or more publication file paths were outside the expected folders."},409,headers);
        const r2DeleteWarnings=[];
        for(const key of safeKeys){try{await env.Publications.delete(key);}catch(e){r2DeleteWarnings.push({key,error:String(e?.message||e)});}}
        if(r2DeleteWarnings.length)return json({ok:false,error:"R2 cleanup failed. The database record was preserved so the deletion can be retried safely.",details:r2DeleteWarnings},502,headers);
        await env.DB.batch([
          env.DB.prepare(`DELETE FROM content_assets WHERE post_id=?`).bind(id),
          env.DB.prepare(`DELETE FROM content_posts WHERE id=? AND status='rejected'`).bind(id)
        ]);
        await writeAudit(env,admin.user_id,"content_rejected_deleted","content_post",id,{title:post.title,type:post.type,slug:post.slug,deletedAssetCount:assets.length,deletedR2ObjectCount:safeKeys.length});
        return json({ok:true,deleted:true,id,deletedAssets:assets.length,deletedR2Objects:safeKeys.length},200,headers);
      }

      if (url.pathname === "/api/content/posts/delete-archived-newsletter" && request.method === "POST") {
        const admin=await requireAdmin(request,env);if(!admin)return json({ok:false,error:"Administrator access required."},403,headers);
        if(!env.Publications)return json({ok:false,error:"Publications R2 binding is not configured."},500,headers);
        const body=await safeJson(request),id=String(body?.id||"").trim(),confirmSlug=String(body?.confirmSlug||"").trim();
        const post=await env.DB.prepare(`SELECT * FROM content_posts WHERE id=? AND type='newsletter' AND status='archived' LIMIT 1`).bind(id).first();
        if(!post)return json({ok:false,error:"Archived newsletter not found."},404,headers);
        if(confirmSlug!==post.slug)return json({ok:false,error:"Confirmation slug does not match."},400,headers);
        const assets=(await env.DB.prepare(`SELECT id,storage_key,status,kind FROM content_assets WHERE post_id=?`).bind(id).all()).results||[];
        const keys=new Set();
        for(const asset of assets){if(asset.storage_key)keys.add(String(asset.storage_key));}
        if(post.pdf_key)keys.add(String(post.pdf_key));
        if(post.cover_key)keys.add(String(post.cover_key));
        const safeKeys=[...keys].filter(key=>key.startsWith('publications/newsletter/')||key.startsWith('covers/newsletter/')||key.startsWith(`staging/${id}/`));
        if(safeKeys.length!==keys.size)return json({ok:false,error:"Deletion stopped because one or more publication file paths were outside the expected newsletter folders."},409,headers);
        const r2DeleteWarnings=[];
        for(const key of safeKeys){try{await env.Publications.delete(key);}catch(e){r2DeleteWarnings.push({key,error:String(e?.message||e)});}}
        if(r2DeleteWarnings.length)return json({ok:false,error:"R2 cleanup failed. The database record was preserved so the deletion can be retried safely.",details:r2DeleteWarnings},502,headers);
        await env.DB.batch([
          env.DB.prepare(`DELETE FROM content_assets WHERE post_id=?`).bind(id),
          env.DB.prepare(`DELETE FROM content_posts WHERE id=? AND type='newsletter' AND status='archived'`).bind(id)
        ]);
        await writeAudit(env,admin.user_id,"content_deleted","content_post",id,{title:post.title,type:post.type,slug:post.slug,deletedAssetCount:assets.length,deletedR2ObjectCount:safeKeys.length,wasArchived:true});
        return json({ok:true,deleted:true,id,deletedAssets:assets.length,deletedR2Objects:safeKeys.length,r2DeleteWarnings:[]},200,headers);
      }

      // Public content endpoints are available now but the static Blog/Newsletter pages are not switched to them until Phase 4.
      if (url.pathname === "/api/public/posts" && request.method === "GET") {
        const type=normalizeContentType(url.searchParams.get("type")), featured=url.searchParams.get("featured"),currentNewsletter=url.searchParams.get("currentNewsletter");const clauses=["p.status='published'"];const bind=[];
        if(type){clauses.push("p.type=?");bind.push(type);}if(featured==="1")clauses.push("p.featured=1");if(currentNewsletter==="1")clauses.push("p.type='newsletter' AND p.current_newsletter=1");
        const stmt=env.DB.prepare(`SELECT p.*,u.display_name AS creator_name FROM content_posts p LEFT JOIN admin_users u ON u.id=p.created_by WHERE ${clauses.join(" AND ")} ORDER BY p.current_newsletter DESC,p.featured DESC, COALESCE(p.publication_date,p.published_at) DESC LIMIT 250`);const rows=(await (bind.length?stmt.bind(...bind):stmt).all()).results||[];
        return json({ok:true,posts:rows.map(r=>mapPublicContentPost(r,url.origin))},200,headers);
      }

      if (url.pathname === "/api/public/post" && request.method === "GET") {
        const slug=slugifyContent(url.searchParams.get("slug")||"");if(!slug)return json({ok:false,error:"slug is required."},400,headers);
        const row=await env.DB.prepare(`SELECT p.*,u.display_name AS creator_name FROM content_posts p LEFT JOIN admin_users u ON u.id=p.created_by WHERE lower(p.slug)=lower(?) AND p.status='published' LIMIT 1`).bind(slug).first();if(!row)return json({ok:false,error:"Published post not found."},404,headers);
        return json({ok:true,post:mapPublicContentPost(row,url.origin)},200,headers);
      }

      if (url.pathname === "/api/publication/file" && request.method === "GET") {
        if(!env.Publications)return json({ok:false,error:"Publications R2 binding is not configured."},500,headers);
        const id=String(url.searchParams.get("id")||"").trim(),kind=String(url.searchParams.get("kind")||"").trim();if(!id||!["pdf","cover"].includes(kind))return json({ok:false,error:"id and kind are required."},400,headers);
        const post=await env.DB.prepare(`SELECT id,title,pdf_key,cover_key,status FROM content_posts WHERE id=? AND status='published' LIMIT 1`).bind(id).first();if(!post)return json({ok:false,error:"Published post not found."},404,headers);
        const key=kind==="pdf"?post.pdf_key:post.cover_key;if(!key)return json({ok:false,error:"File is not available."},404,headers);const obj=await env.Publications.get(key);if(!obj)return json({ok:false,error:"File is missing from R2."},404,headers);
        return publicationObjectResponse(obj,kind==="pdf"?"application/pdf":obj.httpMetadata?.contentType||"image/webp",kind==="pdf"?`${post.title}.pdf`:`cover-${post.id}`,corsOrigin,true);
      }


      if (url.pathname === "/api/gallery/workflow/create" && request.method === "POST") {
        const session=await requireSession(request,env);
        if(!session) return json({ok:false,error:"Unauthorized."},401,headers);
        const body=await safeJson(request); if(!body) return json({ok:false,error:"Invalid JSON body."},400,headers);
        const images=Array.isArray(body.images)?body.images:[];
        const sourceBatchId=String(body.sourceBatchId||"").trim(), processorVersion=String(body.processorVersion||"Gallery v3").trim(), sourceFileName=String(body.sourceFileName||"").trim();
        if(!sourceBatchId||!images.length) return json({ok:false,error:"A batch ID and image records are required."},400,headers);
        if(images.length>500) return json({ok:false,error:"A single approval batch is limited to 500 images."},400,headers);
        const clean=[]; let activeCount=0,removedCount=0;
        for(let index=0;index<images.length;index++){
          const i=images[index]||{}, removed=Boolean(i.removed), digest=String(i.digest||"").trim().toLowerCase(), webFile=String(i.webFile||"").trim(), sourceId=String(i.sourceId||i.id||"").trim();
          const year=i.year==null?null:Number(i.year), rotation=normalizeRotation(i.rotation);
          if(!sourceId||!digest||!webFile||!/^[a-zA-Z0-9._-]+\.webp$/i.test(webFile)) return json({ok:false,error:`Invalid image record at position ${index+1}.`},400,headers);
          if(!removed&&(!Number.isInteger(year)||year<1900||year>2099)) return json({ok:false,error:`${webFile} needs a valid year before submission.`},400,headers);
          if(!removed){const dupe=await env.DB.prepare(`SELECT id FROM gallery_images WHERE lower(digest)=? LIMIT 1`).bind(digest).first();if(dupe)return json({ok:false,error:`${webFile} is already present in the live gallery.`},409,headers);activeCount++;}else removedCount++;
          clean.push({sourceId,digest,originalName:String(i.originalName||webFile).slice(0,500),webFile,width:Number(i.width)||0,height:Number(i.height)||0,rotation,year,decade:year?`${Math.floor(year/10)*10}s`:String(i.decade||"").slice(0,20),alt:String(i.alt||i.originalName||webFile).slice(0,500),removed:removed?1:0,sortOrder:Number.isInteger(Number(i.sortOrder))?Number(i.sortOrder):index});
        }
        if(!activeCount) return json({ok:false,error:"At least one active image is required."},400,headers);
        const id=crypto.randomUUID();
        const statements=[env.DB.prepare(`INSERT INTO gallery_approval_batches (id,source_batch_id,processor_version,source_file_name,status,image_count,active_count,removed_count,submitted_by) VALUES (?,?,?,?, 'draft_uploading',?,?,?,?)`).bind(id,sourceBatchId,processorVersion,sourceFileName,clean.length,activeCount,removedCount,session.user_id)];
        for(const i of clean)statements.push(env.DB.prepare(`INSERT INTO gallery_approval_images (approval_batch_id,source_id,digest,original_name,web_file,width,height,rotation,year,decade,alt,removed,sort_order) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(id,i.sourceId,i.digest,i.originalName,i.webFile,i.width,i.height,i.rotation,i.year,i.decade,i.alt,i.removed,i.sortOrder));
        await env.DB.batch(statements);
        await writeAudit(env,session.user_id,"gallery_submission_created","gallery_approval_batch",id,{sourceBatchId,activeCount,removedCount});
        return json({ok:true,batch:{id,status:"draft_uploading",activeCount,removedCount}},201,headers);
      }

      if (url.pathname === "/api/gallery/workflow/upload" && request.method === "POST") {
        const session=await requireSession(request,env); if(!session)return json({ok:false,error:"Unauthorized."},401,headers);
        const batchId=String(url.searchParams.get("batchId")||""), imageId=String(url.searchParams.get("imageId")||""), variant=String(url.searchParams.get("variant")||"");
        if(!batchId||!imageId||!["display","thumb"].includes(variant))return json({ok:false,error:"batchId, imageId, and a valid variant are required."},400,headers);
        const batchRow=await env.DB.prepare(`SELECT id,status,submitted_by FROM gallery_approval_batches WHERE id=? LIMIT 1`).bind(batchId).first();
        if(!batchRow)return json({ok:false,error:"Approval batch not found."},404,headers);
        if(batchRow.status!=="draft_uploading")return json({ok:false,error:"This submission is no longer accepting files."},409,headers);
        if(Number(batchRow.submitted_by)!==Number(session.user_id)&&session.role!=="admin")return json({ok:false,error:"You cannot upload files to another user's submission."},403,headers);
        const img=await env.DB.prepare(`SELECT source_id,web_file,removed FROM gallery_approval_images WHERE approval_batch_id=? AND source_id=? LIMIT 1`).bind(batchId,imageId).first();
        if(!img||img.removed)return json({ok:false,error:"Active image record not found."},404,headers);
        const length=Number(request.headers.get("Content-Length")||0);if(length>20*1024*1024)return json({ok:false,error:"Individual WebP files are limited to 20 MB."},413,headers);
        const bytes=await request.arrayBuffer();if(!bytes.byteLength||bytes.byteLength>20*1024*1024)return json({ok:false,error:"The uploaded WebP is empty or too large."},400,headers);
        const folder=variant==="thumb"?"thumbs":"display", key=`staging/${batchId}/${folder}/${img.web_file}`;
        await env.GALLERY.put(key,bytes,{httpMetadata:{contentType:"image/webp"},customMetadata:{approvalBatchId:batchId,sourceId:imageId,variant}});
        return json({ok:true,key,size:bytes.byteLength},200,headers);
      }

      if (url.pathname === "/api/gallery/workflow/submit" && request.method === "POST") {
        const session=await requireSession(request,env);if(!session)return json({ok:false,error:"Unauthorized."},401,headers);
        const body=await safeJson(request);const batchId=String(body?.batchId||"");
        const b=await env.DB.prepare(`SELECT * FROM gallery_approval_batches WHERE id=? LIMIT 1`).bind(batchId).first();if(!b)return json({ok:false,error:"Approval batch not found."},404,headers);
        if(b.status!=="draft_uploading")return json({ok:false,error:"This batch cannot be submitted in its current state."},409,headers);
        if(Number(b.submitted_by)!==Number(session.user_id)&&session.role!=="admin")return json({ok:false,error:"You cannot submit another user's batch."},403,headers);
        const imgs=(await env.DB.prepare(`SELECT source_id,web_file,removed FROM gallery_approval_images WHERE approval_batch_id=? ORDER BY sort_order`).bind(batchId).all()).results||[];
        for(const i of imgs.filter(x=>!x.removed)){for(const folder of ["display","thumbs"]){const obj=await env.GALLERY.head(`staging/${batchId}/${folder}/${i.web_file}`);if(!obj)return json({ok:false,error:`Staged ${folder}/${i.web_file} is missing.`},409,headers);}}
        await env.DB.prepare(`UPDATE gallery_approval_batches SET status='submitted',submitted_at=CURRENT_TIMESTAMP WHERE id=?`).bind(batchId).run();
        await writeAudit(env,session.user_id,"gallery_submitted","gallery_approval_batch",batchId,{activeCount:b.active_count});
        await notifyAdminGroup(env,"approval_required",{
          subject:"Approval required: Gallery upload",
          heading:"Gallery upload awaiting approval",
          bodyHtml:`<p><strong>${escapeHtml(session.display_name||session.email)}</strong> submitted a gallery batch with <strong>${Number(b.active_count)||0}</strong> active image(s).</p>${emailButton("Review Gallery Upload","https://www.tczk.org/admin/gallery/approvals/")}`,
          text:`${session.display_name||session.email} submitted a gallery batch with ${Number(b.active_count)||0} active image(s). Review: https://www.tczk.org/admin/gallery/approvals/`,
          entityType:"gallery_approval_batch",entityId:batchId,actorUserId:session.user_id
        });
        return json({ok:true,batch:{id:batchId,status:"submitted"}},200,headers);
      }

      if (url.pathname === "/api/gallery/workflow/cancel" && request.method === "POST") {
        const session=await requireSession(request,env);if(!session)return json({ok:false,error:"Unauthorized."},401,headers);const body=await safeJson(request);const batchId=String(body?.batchId||"");
        const b=await env.DB.prepare(`SELECT id,status,submitted_by FROM gallery_approval_batches WHERE id=? LIMIT 1`).bind(batchId).first();if(!b)return json({ok:true},200,headers);
        if(Number(b.submitted_by)!==Number(session.user_id)&&session.role!=="admin")return json({ok:false,error:"Forbidden."},403,headers);
        if(b.status==="published")return json({ok:false,error:"Published batches cannot be cancelled."},409,headers);
        await env.DB.prepare(`UPDATE gallery_approval_batches SET status='cancelled' WHERE id=?`).bind(batchId).run();
        await deleteStaging(env,batchId);return json({ok:true},200,headers);
      }

      if (url.pathname === "/api/gallery/approvals" && request.method === "GET") {
        const admin=await requireAdmin(request,env);if(!admin)return json({ok:false,error:"Administrator access required."},403,headers);
        const rows=(await env.DB.prepare(`SELECT b.*,u.email AS submitter_email,u.display_name AS submitter_name FROM gallery_approval_batches b LEFT JOIN admin_users u ON u.id=b.submitted_by WHERE b.status<>'cancelled' ORDER BY CASE b.status WHEN 'submitted' THEN 0 WHEN 'changes_requested' THEN 1 WHEN 'published' THEN 2 ELSE 3 END, COALESCE(b.submitted_at,b.created_at) DESC LIMIT 100`).all()).results||[];
        return json({ok:true,batches:rows.map(mapApprovalBatch)},200,headers);
      }

      if (url.pathname === "/api/gallery/approval" && request.method === "GET") {
        const admin=await requireAdmin(request,env);if(!admin)return json({ok:false,error:"Administrator access required."},403,headers);const id=String(url.searchParams.get("id")||"");
        const b=await env.DB.prepare(`SELECT b.*,u.email AS submitter_email,u.display_name AS submitter_name FROM gallery_approval_batches b LEFT JOIN admin_users u ON u.id=b.submitted_by WHERE b.id=? LIMIT 1`).bind(id).first();if(!b)return json({ok:false,error:"Submission not found."},404,headers);
        const imgs=(await env.DB.prepare(`SELECT source_id,digest,original_name,web_file,width,height,rotation,year,decade,alt,removed,sort_order FROM gallery_approval_images WHERE approval_batch_id=? ORDER BY sort_order`).bind(id).all()).results||[];
        return json({ok:true,batch:{...mapApprovalBatch(b),images:imgs.map(mapApprovalImage)}},200,headers);
      }

      if (url.pathname === "/api/gallery/approval-image" && request.method === "GET") {
        const admin=await requireAdmin(request,env);if(!admin)return json({ok:false,error:"Administrator access required."},403,headers);const batchId=String(url.searchParams.get("batchId")||""),imageId=String(url.searchParams.get("imageId")||""),variant=String(url.searchParams.get("variant")||"thumb");if(!["display","thumb"].includes(variant))return json({ok:false,error:"Invalid variant."},400,headers);
        const img=await env.DB.prepare(`SELECT web_file,removed FROM gallery_approval_images WHERE approval_batch_id=? AND source_id=? LIMIT 1`).bind(batchId,imageId).first();if(!img||img.removed)return json({ok:false,error:"Image not found."},404,headers);const folder=variant==="thumb"?"thumbs":"display",obj=await env.GALLERY.get(`staging/${batchId}/${folder}/${img.web_file}`);if(!obj)return json({ok:false,error:"Staged image not found."},404,headers);
        return new Response(obj.body,{status:200,headers:{...headers,"Content-Type":"image/webp","Cache-Control":"private, no-store"}});
      }

      if (url.pathname === "/api/gallery/approval/return" && request.method === "POST") {
        const admin=await requireAdmin(request,env);if(!admin)return json({ok:false,error:"Administrator access required."},403,headers);const body=await safeJson(request),batchId=String(body?.batchId||""),note=String(body?.note||"").trim();if(note.length<3)return json({ok:false,error:"Add a short note describing the required changes."},400,headers);
        const b=await env.DB.prepare(`SELECT id,status,submitted_by FROM gallery_approval_batches WHERE id=? LIMIT 1`).bind(batchId).first();if(!b)return json({ok:false,error:"Submission not found."},404,headers);if(b.status!=="submitted")return json({ok:false,error:"Only submitted batches can be returned."},409,headers);
        await env.DB.prepare(`UPDATE gallery_approval_batches SET status='changes_requested',reviewed_by=?,reviewed_at=CURRENT_TIMESTAMP,review_note=? WHERE id=?`).bind(admin.user_id,note,batchId).run();
        await writeAudit(env,admin.user_id,"gallery_changes_requested","gallery_approval_batch",batchId,{note});
        await notifyUserById(env,b.submitted_by,{subject:"Changes requested: Gallery upload",heading:"Changes requested",bodyHtml:`<p>Your gallery upload was reviewed and needs changes before it can be published.</p><p><strong>Reviewer note:</strong></p><p>${escapeHtml(note)}</p>${emailButton("Open Gallery Uploads","https://www.tczk.org/admin/gallery/")}`,text:`Changes were requested for your gallery upload. Reviewer note: ${note} Open: https://www.tczk.org/admin/gallery/`,category:"submission_changes_requested",entityType:"gallery_approval_batch",entityId:batchId,actorUserId:admin.user_id});
        return json({ok:true},200,headers);
      }

      if (url.pathname === "/api/gallery/approval/publish" && request.method === "POST") {
        const admin=await requireAdmin(request,env);if(!admin)return json({ok:false,error:"Administrator access required."},403,headers);const body=await safeJson(request),batchId=String(body?.batchId||"");
        const b=await env.DB.prepare(`SELECT * FROM gallery_approval_batches WHERE id=? LIMIT 1`).bind(batchId).first();if(!b)return json({ok:false,error:"Submission not found."},404,headers);if(b.status!=="submitted")return json({ok:false,error:"Only submitted batches can be published."},409,headers);
        const imgs=(await env.DB.prepare(`SELECT * FROM gallery_approval_images WHERE approval_batch_id=? AND removed=0 ORDER BY sort_order`).bind(batchId).all()).results||[];if(!imgs.length)return json({ok:false,error:"This batch has no active images."},409,headers);
        const finalKeys=[];
        for(const i of imgs){const dupe=await env.DB.prepare(`SELECT id FROM gallery_images WHERE lower(digest)=lower(?) LIMIT 1`).bind(i.digest).first();if(dupe)return json({ok:false,error:`${i.web_file} became a duplicate after submission. Return the batch for changes.`},409,headers);for(const folder of ["display","thumbs"]){const finalKey=`${folder}/${i.web_file}`;if(await env.GALLERY.head(finalKey))return json({ok:false,error:`R2 already contains ${finalKey}; publication stopped to avoid overwriting an existing object.`},409,headers);if(!(await env.GALLERY.head(`staging/${batchId}/${folder}/${i.web_file}`)))return json({ok:false,error:`Staged ${folder}/${i.web_file} is missing.`},409,headers);}}
        try{
          for(const i of imgs){for(const folder of ["display","thumbs"]){const src=await env.GALLERY.get(`staging/${batchId}/${folder}/${i.web_file}`);const key=`${folder}/${i.web_file}`;await env.GALLERY.put(key,src.body,{httpMetadata:{contentType:"image/webp"}});finalKeys.push(key);}}
          const now=new Date().toISOString(),r2Base="https://pub-05d60b8c7fd242b1a2d873d6fdce99be.r2.dev";
          const stmts=[env.DB.prepare(`INSERT INTO gallery_batches (id,status,processor_version,image_count,published_count,duplicate_count,created_at,reviewed_at,published_at) VALUES (?,?,?,?,?,?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`).bind(batchId,"published",b.processor_version||"Gallery v3",Number(b.image_count)||imgs.length,imgs.length,0)];
          for(const i of imgs){const gid=`zk-${String(i.digest).slice(0,12)}`;stmts.push(env.DB.prepare(`INSERT INTO gallery_images (id,digest,original_name,web_file,batch_id,width,height,rotation,year,decade,alt,caption,event,source,hidden,legacy,thumb_url,display_url,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,0,?,?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`).bind(gid,i.digest,i.original_name,i.web_file,batchId,i.width||0,i.height||0,normalizeRotation(i.rotation),i.year,i.decade||"",i.alt||i.original_name,"","","",`${r2Base}/thumbs/${encodeURIComponent(i.web_file)}`,`${r2Base}/display/${encodeURIComponent(i.web_file)}`));}
          stmts.push(env.DB.prepare(`UPDATE gallery_approval_batches SET status='published',reviewed_by=?,reviewed_at=CURRENT_TIMESTAMP,review_note=NULL,published_at=CURRENT_TIMESTAMP WHERE id=?`).bind(admin.user_id,batchId));
          await env.DB.batch(stmts);
        }catch(e){for(const key of finalKeys){try{await env.GALLERY.delete(key);}catch(_e){}}throw e;}
        await deleteStaging(env,batchId);await writeAudit(env,admin.user_id,"gallery_published","gallery_approval_batch",batchId,{publishedCount:imgs.length});return json({ok:true,publishedCount:imgs.length,batchId},200,headers);
      }


      // Full Gallery Manager -------------------------------------------------
      if (url.pathname === "/api/gallery/manage" && request.method === "GET") {
        const session=await requireSession(request,env);if(!session)return json({ok:false,error:"Unauthorized."},401,headers);
        const result=await env.DB.prepare(`SELECT id,digest,original_name,web_file,batch_id,width,height,rotation,year,decade,alt,caption,event,source,hidden,legacy,thumb_url,display_url,created_at,updated_at FROM gallery_images ORDER BY created_at DESC,id DESC`).all();
        const imgs=(result.results||[]).map(mapManagedImage);
        return json({ok:true,user:publicSessionUser(session),stats:galleryStats(imgs),images:imgs},200,headers);
      }

      if (url.pathname === "/api/gallery/manage/history" && request.method === "GET") {
        const session=await requireSession(request,env);if(!session)return json({ok:false,error:"Unauthorized."},401,headers);
        const id=String(url.searchParams.get("id")||"").trim();if(!id)return json({ok:false,error:"Image id is required."},400,headers);
        const r=await env.DB.prepare(`SELECT a.id,a.action,a.details,a.created_at,u.email,u.display_name FROM audit_log a LEFT JOIN admin_users u ON u.id=a.user_id WHERE a.entity_type='gallery_image' AND a.entity_id=? ORDER BY a.created_at DESC LIMIT 100`).bind(id).all();
        const history=(r.results||[]).map(x=>{let d={};try{d=JSON.parse(x.details||"{}")}catch{}return{id:x.id,action:x.action,actionLabel:galleryActionLabel(x.action),summary:galleryAuditSummary(x.action,d),createdAt:x.created_at,userEmail:x.email||"",userName:x.display_name||""};});
        return json({ok:true,history},200,headers);
      }

      if (url.pathname === "/api/gallery/manage/update" && request.method === "POST") {
        const session=await requireSession(request,env);if(!session)return json({ok:false,error:"Unauthorized."},401,headers);
        if(session.role!=="admin")return json({ok:false,error:"Editors must submit published-image changes for approval."},403,headers);
        const body=await safeJson(request);if(!body)return json({ok:false,error:"Invalid JSON body."},400,headers);
        const id=String(body.id||"").trim();const current=await env.DB.prepare(`SELECT * FROM gallery_images WHERE id=? LIMIT 1`).bind(id).first();if(!current)return json({ok:false,error:"Gallery image not found."},404,headers);
        const clean=cleanGalleryChanges(body.changes,current);if(clean.error)return json({ok:false,error:clean.error},400,headers);
        await env.DB.prepare(`UPDATE gallery_images SET year=?,decade=?,alt=?,caption=?,event=?,source=?,hidden=?,rotation=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`).bind(clean.year,clean.decade,clean.alt,clean.caption,clean.event,clean.source,clean.hidden?1:0,clean.rotation,id).run();
        const changed=galleryDiff(current,clean);await writeAudit(env,session.user_id,"gallery_image_updated","gallery_image",id,{changes:changed});
        const updated=mapManagedImage(await env.DB.prepare(`SELECT * FROM gallery_images WHERE id=?`).bind(id).first());
        const all=(await env.DB.prepare(`SELECT hidden,legacy,year FROM gallery_images`).all()).results||[];
        return json({ok:true,image:updated,stats:{total:all.length,visible:all.filter(x=>!x.hidden).length,hidden:all.filter(x=>x.hidden).length,needsYear:all.filter(x=>x.year==null).length,legacy:all.filter(x=>x.legacy).length}},200,headers);
      }

      if (url.pathname === "/api/gallery/manage/bulk" && request.method === "POST") {
        const admin=await requireAdmin(request,env);if(!admin)return json({ok:false,error:"Administrator access required."},403,headers);
        const body=await safeJson(request);if(!body)return json({ok:false,error:"Invalid JSON body."},400,headers);
        const ids=[...new Set((Array.isArray(body.ids)?body.ids:[]).map(x=>String(x||"").trim()).filter(Boolean))].slice(0,500);if(!ids.length)return json({ok:false,error:"Select at least one image."},400,headers);
        const action=String(body.action||"");let year=null;if(action==="set_year"){year=Number(body.year);if(!Number.isInteger(year)||year<1900||year>2099)return json({ok:false,error:"Year must be between 1900 and 2099."},400,headers);}else if(!["hide","show"].includes(action))return json({ok:false,error:"Unsupported bulk action."},400,headers);
        let count=0;for(const id of ids){const row=await env.DB.prepare(`SELECT id,year,decade,hidden FROM gallery_images WHERE id=?`).bind(id).first();if(!row)continue;if(action==="set_year"){const decade=`${Math.floor(year/10)*10}s`;await env.DB.prepare(`UPDATE gallery_images SET year=?,decade=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`).bind(year,decade,id).run();await writeAudit(env,admin.user_id,"gallery_year_changed","gallery_image",id,{from:row.year,to:year,decade});}else{const hidden=action==="hide"?1:0;await env.DB.prepare(`UPDATE gallery_images SET hidden=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`).bind(hidden,id).run();await writeAudit(env,admin.user_id,hidden?"gallery_image_hidden":"gallery_image_restored","gallery_image",id,{from:Boolean(row.hidden),to:Boolean(hidden)});}count++;}
        const r=await env.DB.prepare(`SELECT * FROM gallery_images ORDER BY created_at DESC,id DESC`).all();const imgs=(r.results||[]).map(mapManagedImage);return json({ok:true,updatedCount:count,images:imgs,stats:galleryStats(imgs)},200,headers);
      }

      if (url.pathname === "/api/gallery/manage/change-request" && request.method === "POST") {
        const session=await requireSession(request,env);if(!session)return json({ok:false,error:"Unauthorized."},401,headers);
        const body=await safeJson(request);if(!body)return json({ok:false,error:"Invalid JSON body."},400,headers);
        const imageId=String(body.imageId||"").trim();const current=await env.DB.prepare(`SELECT * FROM gallery_images WHERE id=? LIMIT 1`).bind(imageId).first();if(!current)return json({ok:false,error:"Gallery image not found."},404,headers);
        const clean=cleanGalleryChanges(body.proposed,current);if(clean.error)return json({ok:false,error:clean.error},400,headers);
        if(session.role==="admin")return json({ok:false,error:"Admins can save gallery changes directly from the Gallery Manager."},409,headers);
        const existing=await env.DB.prepare(`SELECT id FROM gallery_change_requests WHERE image_id=? AND status='submitted' LIMIT 1`).bind(imageId).first();if(existing)return json({ok:false,error:"This image already has a pending change request."},409,headers);
        const id=`gcr_${Date.now()}_${randomToken(6)}`;const snapshot=managedSnapshot(current);const proposed={year:clean.year,decade:clean.decade,alt:clean.alt,caption:clean.caption,event:clean.event,source:clean.source,hidden:clean.hidden,rotation:clean.rotation};
        await env.DB.prepare(`INSERT INTO gallery_change_requests (id,image_id,status,current_json,proposed_json,request_note,requested_by) VALUES (?,?,'submitted',?,?,?,?)`).bind(id,imageId,JSON.stringify(snapshot),JSON.stringify(proposed),String(body.note||"").trim().slice(0,1000),session.user_id).run();
        await writeAudit(env,session.user_id,"gallery_change_requested","gallery_image",imageId,{requestId:id,changes:galleryDiff(current,clean)});
        await notifyAdminGroup(env,"approval_required",{
          subject:"Approval required: Gallery change",
          heading:"Gallery change awaiting approval",
          bodyHtml:`<p><strong>${escapeHtml(session.display_name||session.email)}</strong> requested changes to <strong>${escapeHtml(current.original_name||imageId)}</strong>.</p>${emailButton("Review Gallery Changes","https://www.tczk.org/admin/gallery/changes/")}`,
          text:`${session.display_name||session.email} requested gallery changes. Review: https://www.tczk.org/admin/gallery/changes/`,
          entityType:"gallery_change_request",entityId:id,actorUserId:session.user_id
        });
        return json({ok:true,id,status:"submitted"},200,headers);
      }

      if (url.pathname === "/api/gallery/manage/change-requests" && request.method === "GET") {
        const session=await requireSession(request,env);if(!session)return json({ok:false,error:"Unauthorized."},401,headers);
        const where=session.role==="admin"?`c.status='submitted'`:`c.requested_by=? AND c.status IN ('submitted','changes_requested')`;
        const stmt=env.DB.prepare(`SELECT c.*,u.email AS requester_email,u.display_name AS requester_name,g.original_name,g.thumb_url,g.display_url,g.legacy FROM gallery_change_requests c LEFT JOIN admin_users u ON u.id=c.requested_by LEFT JOIN gallery_images g ON g.id=c.image_id WHERE ${where} ORDER BY c.created_at DESC`);const r=session.role==="admin"?await stmt.all():await stmt.bind(session.user_id).all();
        const requests=(r.results||[]).map(mapGalleryChangeRequest);return json({ok:true,requests},200,headers);
      }

      if (url.pathname === "/api/gallery/manage/change-request/review" && request.method === "POST") {
        const admin=await requireAdmin(request,env);if(!admin)return json({ok:false,error:"Administrator access required."},403,headers);
        const body=await safeJson(request);if(!body)return json({ok:false,error:"Invalid JSON body."},400,headers);const id=String(body.id||"").trim(),decision=String(body.decision||"").trim(),note=String(body.note||"").trim().slice(0,2000);if(!["approve","return","reject"].includes(decision))return json({ok:false,error:"Invalid review decision."},400,headers);if((decision==="return"||decision==="reject")&&!note)return json({ok:false,error:"A review note is required."},400,headers);
        const req=await env.DB.prepare(`SELECT * FROM gallery_change_requests WHERE id=? LIMIT 1`).bind(id).first();if(!req)return json({ok:false,error:"Change request not found."},404,headers);if(req.status!=="submitted")return json({ok:false,error:"Only submitted requests can be reviewed."},409,headers);
        if(decision==="approve"){const current=await env.DB.prepare(`SELECT * FROM gallery_images WHERE id=? LIMIT 1`).bind(req.image_id).first();if(!current)return json({ok:false,error:"Gallery image no longer exists."},404,headers);let proposed={};try{proposed=JSON.parse(req.proposed_json||"{}")}catch{return json({ok:false,error:"Stored change request is malformed."},500,headers)}const clean=cleanGalleryChanges(proposed,current);if(clean.error)return json({ok:false,error:clean.error},400,headers);await env.DB.prepare(`UPDATE gallery_images SET year=?,decade=?,alt=?,caption=?,event=?,source=?,hidden=?,rotation=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`).bind(clean.year,clean.decade,clean.alt,clean.caption,clean.event,clean.source,clean.hidden?1:0,clean.rotation,req.image_id).run();await env.DB.prepare(`UPDATE gallery_change_requests SET status='approved',reviewed_by=?,reviewed_at=CURRENT_TIMESTAMP,review_note=? WHERE id=?`).bind(admin.user_id,note,id).run();await writeAudit(env,admin.user_id,"gallery_change_approved","gallery_image",req.image_id,{requestId:id,changes:galleryDiff(current,clean),note});await notifyUserById(env,req.requested_by,{subject:"Gallery change approved",heading:"Change approved",bodyHtml:`<p>Your requested changes to a gallery image were approved and applied.</p>${note?`<p><strong>Reviewer note:</strong></p><p>${escapeHtml(note)}</p>`:""}${emailButton("Open Gallery Manager","https://www.tczk.org/admin/gallery/manager/")}`,text:`Your requested gallery changes were approved and applied.${note?` Reviewer note: ${note}`:""}`,category:"submission_approved",entityType:"gallery_change_request",entityId:id,actorUserId:admin.user_id});return json({ok:true,status:"approved"},200,headers);}
        const newStatus=decision==="return"?"changes_requested":"rejected";await env.DB.prepare(`UPDATE gallery_change_requests SET status=?,reviewed_by=?,reviewed_at=CURRENT_TIMESTAMP,review_note=? WHERE id=?`).bind(newStatus,admin.user_id,note,id).run();await writeAudit(env,admin.user_id,decision==="return"?"gallery_change_returned":"gallery_change_rejected","gallery_image",req.image_id,{requestId:id,note});await notifyUserById(env,req.requested_by,{subject:decision==="return"?"Changes requested: Gallery change":"Gallery change rejected",heading:decision==="return"?"Changes requested":"Change rejected",bodyHtml:`<p>${decision==="return"?"Your gallery change request needs revisions before it can be approved.":"Your gallery change request was rejected."}</p><p><strong>Reviewer note:</strong></p><p>${escapeHtml(note)}</p>${emailButton("Open Gallery Manager","https://www.tczk.org/admin/gallery/manager/")}`,text:`${decision==="return"?"Changes were requested for your gallery change request.":"Your gallery change request was rejected."} Reviewer note: ${note}`,category:decision==="return"?"submission_changes_requested":"submission_rejected",entityType:"gallery_change_request",entityId:id,actorUserId:admin.user_id});return json({ok:true,status:newStatus},200,headers);
      }

      if (url.pathname === "/api/gallery-data.js" && request.method === "GET") {
        const result=await env.DB.prepare(`SELECT id,display_url,thumb_url,year,decade,alt,caption,event,source,rotation FROM gallery_images WHERE hidden=0 ORDER BY created_at ASC,id ASC`).all();
        const data=(result.results||[]).map(r=>({id:r.id,src:r.display_url,display:r.display_url,thumb:r.thumb_url,year:r.year,decade:r.decade,alt:r.alt||"",caption:r.caption||"",event:r.event||"",source:r.source||"",rotation:Number(r.rotation)||0}));
        return new Response(`window.GALLERY_IMAGES=${JSON.stringify(data)};`,{status:200,headers:{...headers,"Content-Type":"application/javascript; charset=utf-8","Cache-Control":"public, max-age=60"}});
      }

      if (url.pathname === "/api/gallery" && request.method === "GET") {
        const result=await env.DB.prepare(`SELECT id,digest,original_name,web_file,batch_id,width,height,rotation,year,decade,alt,caption,event,source,hidden,legacy,thumb_url,display_url,created_at,updated_at FROM gallery_images WHERE hidden=0 ORDER BY created_at ASC,id ASC`).all();
        return json({ok:true,count:result.results?.length??0,images:result.results??[]},200,headers);
      }

      if (url.pathname === "/api/gallery/check-duplicates" && request.method === "POST") {
        const session=await requireSession(request,env);
        if(!session) return json({ok:false,error:"Unauthorized."},401,headers);
        const body=await safeJson(request); if(!body) return json({ok:false,error:"Invalid JSON body."},400,headers);
        const digests=Array.isArray(body?.digests)?body.digests:[];
        if(!digests.length) return json({ok:true,checked:0,duplicates:[],newDigests:[]},200,headers);
        const clean=[...new Set(digests.map(x=>String(x||"").trim().toLowerCase()).filter(Boolean))];
        const duplicates=[],newDigests=[];
        for(const digest of clean){
          const row=await env.DB.prepare(`SELECT id,digest,web_file,year,decade,hidden,legacy,thumb_url,display_url FROM gallery_images WHERE lower(digest)=? LIMIT 1`).bind(digest).first();
          if(row)duplicates.push(row);else newDigests.push(digest);
        }
        return json({ok:true,checked:clean.length,duplicateCount:duplicates.length,newCount:newDigests.length,duplicates,newDigests},200,headers);
      }


      // Family tree ----------------------------------------------------------
      // D1 is the authoritative family-tree store. The existing public viewer
      // can remain on Google Sheets until it is deliberately switched over.

      // Authenticated family/member data for the Admin portal.
      if (url.pathname === "/api/family-tree/families" && request.method === "GET") {
        const session=await requireSession(request,env);
        if(!session) return json({ok:false,error:"Unauthorized."},401,headers);

        const families=(await env.DB.prepare(`
          SELECT f.code,f.name,f.id_prefix,f.display_order,f.active,
                 COUNT(m.unique_id) AS member_count
          FROM family_tree_families f
          LEFT JOIN family_tree_members m
            ON m.family_code=f.code AND m.member_type='lineage'
          GROUP BY f.code,f.name,f.id_prefix,f.display_order,f.active
          ORDER BY f.display_order ASC, lower(f.name) ASC
        `).all()).results||[];

        const sequences=(await env.DB.prepare(`
          SELECT prefix,last_number
          FROM family_tree_id_sequences
          ORDER BY prefix
        `).all()).results||[];

        return json({
          ok:true,
          families:families.map(mapFamilyTreeFamily),
          sequences:sequences.map(r=>({prefix:r.prefix,lastNumber:Number(r.last_number)||0}))
        },200,headers);
      }

      if (url.pathname === "/api/family-tree/members" && request.method === "GET") {
        const session=await requireSession(request,env);
        if(!session) return json({ok:false,error:"Unauthorized."},401,headers);

        const q=String(url.searchParams.get("q")||"").trim();
        const family=String(url.searchParams.get("family")||"").trim().toUpperCase();
        const memberType=normalizeFamilyTreeMemberType(url.searchParams.get("type"));
        const requested=Number(url.searchParams.get("limit")||100);
        const limit=Math.max(1,Math.min(500,Number.isFinite(requested)?Math.floor(requested):100));
        const offset=Math.max(0,Math.floor(Number(url.searchParams.get("offset")||0)||0));

        const clauses=[],bind=[];
        if(q){
          clauses.push(`(
            lower(m.unique_id) LIKE lower(?) OR
            lower(m.name) LIKE lower(?) OR
            CAST(m.roster_number AS TEXT) LIKE ?
          )`);
          const like=`%${q}%`;
          bind.push(like,like,like);
        }
        if(family){clauses.push("m.family_code=?");bind.push(family);}
        if(memberType){clauses.push("m.member_type=?");bind.push(memberType);}
        const where=clauses.length?`WHERE ${clauses.join(" AND ")}`:"";

        const totalRow=await env.DB.prepare(`
          SELECT COUNT(*) AS count
          FROM family_tree_members m
          ${where}
        `).bind(...bind).first();

        const result=await env.DB.prepare(`
          SELECT m.*,
                 f.name AS family_name,
                 b.name AS big_name,
                 (SELECT COUNT(*) FROM family_tree_members l
                   WHERE l.big_unique_id=m.unique_id AND l.member_type='lineage') AS little_count
          FROM family_tree_members m
          LEFT JOIN family_tree_families f ON f.code=m.family_code
          LEFT JOIN family_tree_members b ON b.unique_id=m.big_unique_id
          ${where}
          ORDER BY
            CASE WHEN m.roster_number IS NULL THEN 1 ELSE 0 END,
            m.roster_number ASC,
            lower(COALESCE(m.sort_last_name,m.name)),
            lower(m.name)
          LIMIT ? OFFSET ?
        `).bind(...bind,limit,offset).all();

        return json({
          ok:true,
          total:Number(totalRow?.count)||0,
          limit,
          offset,
          members:(result.results||[]).map(mapFamilyTreeMember)
        },200,headers);
      }

      if (url.pathname === "/api/family-tree/member" && request.method === "GET") {
        const session=await requireSession(request,env);
        if(!session) return json({ok:false,error:"Unauthorized."},401,headers);
        const id=normalizeFamilyTreeId(url.searchParams.get("id"));
        if(!id) return json({ok:false,error:"A valid member ID is required."},400,headers);

        const member=await getFamilyTreeMember(env,id);
        if(!member) return json({ok:false,error:"Member not found."},404,headers);

        const littles=(await env.DB.prepare(`
          SELECT m.*,f.name AS family_name,b.name AS big_name,
                 (SELECT COUNT(*) FROM family_tree_members l
                   WHERE l.big_unique_id=m.unique_id AND l.member_type='lineage') AS little_count
          FROM family_tree_members m
          LEFT JOIN family_tree_families f ON f.code=m.family_code
          LEFT JOIN family_tree_members b ON b.unique_id=m.big_unique_id
          WHERE m.big_unique_id=? AND m.member_type='lineage'
          ORDER BY m.roster_number ASC,lower(m.name)
        `).bind(id).all()).results||[];

        return json({ok:true,member:mapFamilyTreeMember(member),littles:littles.map(mapFamilyTreeMember)},200,headers);
      }

      // Create a member. The client never supplies the final unique ID.
      if (url.pathname === "/api/family-tree/members/create" && request.method === "POST") {
        const admin=await requireAdmin(request,env);
        if(!admin) return json({ok:false,error:"Administrator access required."},403,headers);
        const body=await safeJson(request);
        if(!body) return json({ok:false,error:"Invalid JSON body."},400,headers);

        const clean=await cleanFamilyTreeMemberInput(env,body,null);
        if(clean.error) return json({ok:false,error:clean.error},400,headers);

        let prefix="";
        if(clean.memberType==="lineage"){
          const family=await env.DB.prepare(`SELECT code,id_prefix,active FROM family_tree_families WHERE code=? LIMIT 1`).bind(clean.familyCode).first();
          if(!family||!Number(family.active)) return json({ok:false,error:"Choose an active lineage family."},400,headers);
          prefix=String(family.id_prefix||family.code).trim().toUpperCase();
        }else if(clean.memberType==="lost_to_time"){
          prefix="TMP";
        }else{
          prefix="H";
        }

        const sequence=await env.DB.prepare(`SELECT last_number FROM family_tree_id_sequences WHERE prefix=? LIMIT 1`).bind(prefix).first();
        if(!sequence) return json({ok:false,error:`No ID sequence is configured for ${prefix}.`},500,headers);

        const nextNumber=(Number(sequence.last_number)||0)+1;
        const uniqueId=`${prefix}${String(nextNumber).padStart(3,"0")}`;

        const insert=env.DB.prepare(`
          INSERT INTO family_tree_members
            (unique_id,name,sort_last_name,roster_number,member_type,family_code,big_unique_id,
             founding_father,initiated_year,graduation_year,notes,created_at,updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)
        `).bind(
          uniqueId,clean.name,clean.sortLastName,clean.rosterNumber,clean.memberType,
          clean.familyCode,clean.bigUniqueId,clean.foundingFather,
          clean.initiatedYear,clean.graduationYear,clean.notes
        );

        const advance=env.DB.prepare(`
          UPDATE family_tree_id_sequences
          SET last_number=?
          WHERE prefix=? AND last_number=?
        `).bind(nextNumber,prefix,Number(sequence.last_number)||0);

        try{
          // D1 batch executes these statements together. A primary-key collision
          // or stale sequence update prevents us from silently reusing an ID.
          const results=await env.DB.batch([insert,advance]);
          const changed=Number(results?.[1]?.meta?.changes||0);
          if(changed!==1) throw new Error("The ID sequence changed while this member was being created. Please try again.");
        }catch(e){
          const message=String(e?.message||e);
          if(/UNIQUE constraint failed.*unique_id/i.test(message))
            return json({ok:false,error:"That generated member ID already exists. Refresh the family-tree data and try again."},409,headers);
          throw e;
        }

        await writeAudit(env,admin.user_id,"family_tree_member_created","family_tree_member",uniqueId,{
          name:clean.name,memberType:clean.memberType,familyCode:clean.familyCode,bigUniqueId:clean.bigUniqueId,
          rosterNumber:clean.rosterNumber
        });

        const created=await getFamilyTreeMember(env,uniqueId);
        return json({ok:true,member:mapFamilyTreeMember(created)},201,headers);
      }

      // Update historical/member data without ever changing the permanent unique ID.
      if (url.pathname === "/api/family-tree/members/update" && request.method === "POST") {
        const admin=await requireAdmin(request,env);
        if(!admin) return json({ok:false,error:"Administrator access required."},403,headers);
        const body=await safeJson(request);
        if(!body) return json({ok:false,error:"Invalid JSON body."},400,headers);

        const id=normalizeFamilyTreeId(body.uniqueId||body.unique_id);
        if(!id) return json({ok:false,error:"A valid member ID is required."},400,headers);
        const current=await env.DB.prepare(`SELECT * FROM family_tree_members WHERE unique_id=? LIMIT 1`).bind(id).first();
        if(!current) return json({ok:false,error:"Member not found."},404,headers);

        const clean=await cleanFamilyTreeMemberInput(env,body,current);
        if(clean.error) return json({ok:false,error:clean.error},400,headers);

        const before=familyTreeSnapshot(current);
        await env.DB.prepare(`
          UPDATE family_tree_members
          SET name=?,sort_last_name=?,roster_number=?,member_type=?,family_code=?,big_unique_id=?,
              founding_father=?,initiated_year=?,graduation_year=?,notes=?,updated_at=CURRENT_TIMESTAMP
          WHERE unique_id=?
        `).bind(
          clean.name,clean.sortLastName,clean.rosterNumber,clean.memberType,clean.familyCode,
          clean.bigUniqueId,clean.foundingFather,clean.initiatedYear,clean.graduationYear,
          clean.notes,id
        ).run();

        const updated=await getFamilyTreeMember(env,id);
        await writeAudit(env,admin.user_id,"family_tree_member_updated","family_tree_member",id,{
          before,after:familyTreeSnapshot(updated)
        });
        return json({ok:true,member:mapFamilyTreeMember(updated)},200,headers);
      }


      // Family-tree change-request workflow ---------------------------------

      if (url.pathname === "/api/family-tree/changes" && request.method === "GET") {
        const session=await requireSession(request,env);
        if(!session) return json({ok:false,error:"Unauthorized."},401,headers);

        const status=String(url.searchParams.get("status")||"").trim().toLowerCase();
        const allowedStatuses=new Set(["submitted","changes_requested","approved","rejected","cancelled"]);
        const clauses=[],bind=[];
        if(status){
          if(!allowedStatuses.has(status)) return json({ok:false,error:"Invalid request status."},400,headers);
          clauses.push("r.status=?"); bind.push(status);
        }

        // Editors see only their own submissions. P1/P2 can review the full queue.
        if(Number(session.priority)>=3){
          clauses.push("r.requested_by=?"); bind.push(session.user_id);
        }

        const where=clauses.length?`WHERE ${clauses.join(" AND ")}`:"";
        const rows=(await env.DB.prepare(`
          SELECT r.*,
                 u.display_name AS requester_name,u.email AS requester_email,
                 rv.display_name AS reviewer_name,rv.email AS reviewer_email
          FROM family_tree_change_requests r
          LEFT JOIN admin_users u ON u.id=r.requested_by
          LEFT JOIN admin_users rv ON rv.id=r.reviewed_by
          ${where}
          ORDER BY
            CASE r.status WHEN 'submitted' THEN 0 WHEN 'changes_requested' THEN 1 ELSE 2 END,
            datetime(r.created_at) DESC
          LIMIT 250
        `).bind(...bind).all()).results||[];

        return json({ok:true,requests:rows.map(mapFamilyTreeChangeRequest)},200,headers);
      }

      if (url.pathname === "/api/family-tree/changes/submit" && request.method === "POST") {
        const session=await requireSession(request,env);
        if(!session) return json({ok:false,error:"Unauthorized."},401,headers);
        const body=await safeJson(request);
        if(!body) return json({ok:false,error:"Invalid JSON body."},400,headers);

        const requestType=String(body.requestType||body.request_type||"").trim().toLowerCase();
        if(!["create","update","lost_to_time"].includes(requestType))
          return json({ok:false,error:"Request type must be create, update, or lost_to_time."},400,headers);

        let memberId=null,current=null,clean=null;
        if(requestType==="create"){
          clean=await cleanFamilyTreeMemberInput(env,body.proposed||body,null);
          if(clean.error) return json({ok:false,error:clean.error},400,headers);
        }else{
          memberId=normalizeFamilyTreeId(body.memberUniqueId||body.member_unique_id||body.uniqueId);
          if(!memberId) return json({ok:false,error:"A valid member ID is required."},400,headers);
          current=await env.DB.prepare(`SELECT * FROM family_tree_members WHERE unique_id=? LIMIT 1`).bind(memberId).first();
          if(!current) return json({ok:false,error:"Member not found."},404,headers);

          const proposed={...(body.proposed||body)};
          if(requestType==="lost_to_time") proposed.memberType="lost_to_time";
          clean=await cleanFamilyTreeMemberInput(env,proposed,current);
          if(clean.error) return json({ok:false,error:clean.error},400,headers);
        }

        const id=crypto.randomUUID();
        const proposedJson=JSON.stringify(familyTreeCleanSnapshot(clean));
        const currentJson=current?JSON.stringify(familyTreeSnapshot(current)):null;
        const note=String(body.requestNote||body.request_note||"").trim().slice(0,2000);

        await env.DB.prepare(`
          INSERT INTO family_tree_change_requests
            (id,request_type,member_unique_id,proposed_json,current_json,request_note,status,requested_by,created_at,updated_at)
          VALUES (?,?,?,?,?,?,'submitted',?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)
        `).bind(id,requestType,memberId,proposedJson,currentJson,note,session.user_id).run();

        await writeAudit(env,session.user_id,"family_tree_change_submitted","family_tree_change_request",id,{
          requestType,memberUniqueId:memberId
        });

        return json({ok:true,id,status:"submitted"},201,headers);
      }

      if (url.pathname === "/api/family-tree/changes/review" && request.method === "POST") {
        const admin=await requireAdmin(request,env);
        if(!admin) return json({ok:false,error:"Priority 1 or Priority 2 administrator access required."},403,headers);
        const body=await safeJson(request);
        if(!body) return json({ok:false,error:"Invalid JSON body."},400,headers);

        const requestId=String(body.requestId||body.request_id||"").trim();
        const action=String(body.action||"").trim().toLowerCase();
        const reviewNote=String(body.reviewNote||body.review_note||"").trim().slice(0,2000);
        if(!requestId) return json({ok:false,error:"Change-request ID is required."},400,headers);
        if(!["approve","reject","changes_requested"].includes(action))
          return json({ok:false,error:"Review action must be approve, reject, or changes_requested."},400,headers);

        const req=await env.DB.prepare(`SELECT * FROM family_tree_change_requests WHERE id=? LIMIT 1`).bind(requestId).first();
        if(!req) return json({ok:false,error:"Change request not found."},404,headers);
        if(!["submitted","changes_requested"].includes(req.status))
          return json({ok:false,error:"This change request is no longer pending review."},409,headers);

        if(action==="reject"||action==="changes_requested"){
          const newStatus=action==="reject"?"rejected":"changes_requested";
          await env.DB.prepare(`
            UPDATE family_tree_change_requests
            SET status=?,reviewed_by=?,review_note=?,reviewed_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP
            WHERE id=?
          `).bind(newStatus,admin.user_id,reviewNote,requestId).run();

          await writeAudit(env,admin.user_id,`family_tree_change_${newStatus}`,"family_tree_change_request",requestId,{
            requestType:req.request_type,memberUniqueId:req.member_unique_id,reviewNote
          });
          return json({ok:true,id:requestId,status:newStatus},200,headers);
        }

        let proposed={};
        try{proposed=JSON.parse(req.proposed_json||"{}");}
        catch{return json({ok:false,error:"Stored proposal data is invalid."},500,headers);}

        let appliedMemberId=req.member_unique_id||null;

        if(req.request_type==="create"){
          const clean=await cleanFamilyTreeMemberInput(env,proposed,null);
          if(clean.error) return json({ok:false,error:`Proposal can no longer be applied: ${clean.error}`},409,headers);
          const created=await createFamilyTreeMemberRecord(env,clean);
          appliedMemberId=created.uniqueId;
        }else{
          const current=await env.DB.prepare(`SELECT * FROM family_tree_members WHERE unique_id=? LIMIT 1`).bind(req.member_unique_id).first();
          if(!current) return json({ok:false,error:"The member no longer exists, so this proposal cannot be applied."},409,headers);

          // Detect stale proposals instead of overwriting a newer administrator correction.
          let submittedCurrent={};
          try{submittedCurrent=JSON.parse(req.current_json||"{}");}catch{}
          if(JSON.stringify(familyTreeSnapshot(current))!==JSON.stringify(submittedCurrent))
            return json({ok:false,error:"This member changed after the request was submitted. Review the current record before approving."},409,headers);

          const clean=await cleanFamilyTreeMemberInput(env,proposed,current);
          if(clean.error) return json({ok:false,error:`Proposal can no longer be applied: ${clean.error}`},409,headers);
          await updateFamilyTreeMemberRecord(env,req.member_unique_id,clean);
        }

        await env.DB.prepare(`
          UPDATE family_tree_change_requests
          SET status='approved',member_unique_id=?,reviewed_by=?,review_note=?,
              reviewed_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP
          WHERE id=?
        `).bind(appliedMemberId,admin.user_id,reviewNote,requestId).run();

        await writeAudit(env,admin.user_id,"family_tree_change_approved","family_tree_change_request",requestId,{
          requestType:req.request_type,memberUniqueId:appliedMemberId,requestedBy:req.requested_by,reviewNote
        });

        const member=appliedMemberId?await getFamilyTreeMember(env,appliedMemberId):null;
        return json({ok:true,id:requestId,status:"approved",member:member?mapFamilyTreeMember(member):null},200,headers);
      }

      if (url.pathname === "/api/family-tree/changes/cancel" && request.method === "POST") {
        const session=await requireSession(request,env);
        if(!session) return json({ok:false,error:"Unauthorized."},401,headers);
        const body=await safeJson(request);
        if(!body) return json({ok:false,error:"Invalid JSON body."},400,headers);
        const requestId=String(body.requestId||body.request_id||"").trim();
        const req=await env.DB.prepare(`SELECT id,requested_by,status FROM family_tree_change_requests WHERE id=? LIMIT 1`).bind(requestId).first();
        if(!req) return json({ok:false,error:"Change request not found."},404,headers);
        const elevated=Number(session.priority)<=2;
        if(!elevated&&Number(req.requested_by)!==Number(session.user_id))
          return json({ok:false,error:"You can only cancel your own change requests."},403,headers);
        if(!["submitted","changes_requested"].includes(req.status))
          return json({ok:false,error:"Only pending requests can be cancelled."},409,headers);

        await env.DB.prepare(`
          UPDATE family_tree_change_requests
          SET status='cancelled',updated_at=CURRENT_TIMESTAMP
          WHERE id=?
        `).bind(requestId).run();
        await writeAudit(env,session.user_id,"family_tree_change_cancelled","family_tree_change_request",requestId,{});
        return json({ok:true,id:requestId,status:"cancelled"},200,headers);
      }

      // Permanent deletion is intentionally restricted to Priority 1.
      if (url.pathname === "/api/family-tree/members/delete" && request.method === "POST") {
        const admin=await requirePrimaryAdmin(request,env);
        if(!admin) return json({ok:false,error:"Priority 1 administrator access required."},403,headers);
        const body=await safeJson(request);
        if(!body) return json({ok:false,error:"Invalid JSON body."},400,headers);

        const id=normalizeFamilyTreeId(body.uniqueId||body.unique_id);
        if(!id) return json({ok:false,error:"A valid member ID is required."},400,headers);
        const confirmation=String(body.confirmation||"").trim().toUpperCase();
        if(confirmation!==`DELETE ${id}`)
          return json({ok:false,error:`Type DELETE ${id} to confirm permanent deletion.`},400,headers);

        const reason=String(body.reason||"").trim().slice(0,1000);
        if(reason.length<3) return json({ok:false,error:"Enter a reason for permanent deletion."},400,headers);

        const current=await getFamilyTreeMember(env,id);
        if(!current) return json({ok:false,error:"Member not found."},404,headers);

        const dependents=(await env.DB.prepare(`
          SELECT unique_id,name,member_type
          FROM family_tree_members
          WHERE big_unique_id=?
          ORDER BY roster_number,lower(name)
        `).bind(id).all()).results||[];
        if(dependents.length){
          return json({
            ok:false,
            error:"This member cannot be deleted while other records list him as their Big Brother.",
            dependents:dependents.map(x=>({uniqueId:x.unique_id,name:x.name,memberType:x.member_type}))
          },409,headers);
        }

        const snapshot=familyTreeSnapshot(current);

        // Preserve historical request JSON while releasing the FK to the member row.
        await env.DB.batch([
          env.DB.prepare(`UPDATE family_tree_change_requests SET member_unique_id=NULL,updated_at=CURRENT_TIMESTAMP WHERE member_unique_id=?`).bind(id),
          env.DB.prepare(`DELETE FROM family_tree_members WHERE unique_id=?`).bind(id)
        ]);

        await writeAudit(env,admin.user_id,"family_tree_member_deleted","family_tree_member",id,{
          reason,snapshot
        });

        // Sequence counters are deliberately NOT decremented. Deleted IDs are never reused.
        return json({ok:true,deleted:true,uniqueId:id},200,headers);
      }

      // Public historical-information submission from the Family Tree.
      const familyTreeInformationPath=url.pathname.replace(/\/+$/,"")||"/";
      if (familyTreeInformationPath === "/api/public/family-tree/information" && request.method === "GET") {
        return json({ok:true,endpoint:"family-tree-information",method:"POST",emailConfigured:Boolean(env.NOREPLY_SMTP_USERNAME&&env.NOREPLY_SMTP_PASSWORD)},200,headers);
      }
      if (familyTreeInformationPath === "/api/public/family-tree/information" && request.method === "POST") {
        if (!allowedOrigins.has(origin)) return json({ok:false,error:"Origin not allowed."},403,headers);
        if (!env.NOREPLY_SMTP_USERNAME || !env.NOREPLY_SMTP_PASSWORD) return json({ok:false,error:"Historical-information email is not configured."},503,headers);
        const body=await safeJson(request);
        if(!body) return json({ok:false,error:"Invalid submission."},400,headers);
        if(String(body.website||"").trim()) return json({ok:true,received:true,confirmationSent:true},200,headers);

        const memberId=String(body.memberId||"").trim().toUpperCase();
        const submitterName=String(body.submitterName||"").trim().slice(0,120);
        const submitterEmail=normalizeEmail(body.submitterEmail||"");
        const relationship=String(body.relationship||"").trim().slice(0,180);
        const information=String(body.information||"").trim().slice(0,5000);
        const source=String(body.source||"").trim().slice(0,2000);
        if(!/^[A-Z]{1,3}\d{3}$/.test(memberId)) return json({ok:false,error:"That historical record is not valid."},400,headers);
        if(submitterName.length<2) return json({ok:false,error:"Please enter your name."},400,headers);
        if(!isEmail(submitterEmail)) return json({ok:false,error:"Please enter a valid email address."},400,headers);
        if(information.length<5) return json({ok:false,error:"Please provide the historical information you would like us to review."},400,headers);

        const member=await env.DB.prepare(`SELECT m.unique_id,m.name,m.roster_number,m.member_type,m.family_code,m.big_unique_id,m.initiated_year,m.graduation_year,f.name AS family_name FROM family_tree_members m LEFT JOIN family_tree_families f ON f.code=m.family_code WHERE m.unique_id=? LIMIT 1`).bind(memberId).first();
        if(!member) return json({ok:false,error:"The selected historical record could not be found."},404,headers);
        if(String(member.member_type||"").trim().toLowerCase()!=="lost_to_time") return json({ok:false,error:"This form is available only for Brothers Lost to Time."},400,headers);

        const p1=(await env.DB.prepare(`SELECT email FROM admin_users WHERE active=1 AND priority=1 AND deleted_at IS NULL ORDER BY lower(email)`).all()).results||[];
        const recipients=[...new Set(["admin@tczk.org",...p1.map(r=>normalizeEmail(r.email)).filter(isEmail)].map(normalizeEmail).filter(isEmail))];
        const memberName=String(member.name||"").trim()||"Name currently unknown";
        const roster=String(member.roster_number||"").trim();
        const subject=`Family Tree Information — ${memberId} — ${memberName}`.slice(0,300);
        const submittedAt=new Date().toISOString();

        const text=[`A visitor submitted information about a Brother Lost to Time.`,"",`Member: ${memberName}`,`Unique ID: ${memberId}`,roster?`Roster #: ${roster}`:"",member.family_name?`Known family: ${member.family_name}`:"",member.big_unique_id?`Known Big ID: ${member.big_unique_id}`:"","",`Submitted by: ${submitterName}`,`Email: ${submitterEmail}`,relationship?`Relationship / Context: ${relationship}`:"","",`Information provided:`,information,source?`\nSource or Evidence:\n${source}`:"","",`Submitted: ${submittedAt}`].filter(Boolean).join("\n");
        const html=adminEmailTemplate("New Family Tree Information",`<p>A visitor submitted information about a <strong>Brother Lost to Time</strong>.</p><p><strong>Member:</strong> ${escapeHtml(memberName)}<br><strong>Unique ID:</strong> ${escapeHtml(memberId)}${roster?`<br><strong>Roster #:</strong> ${escapeHtml(roster)}`:""}${member.family_name?`<br><strong>Known family:</strong> ${escapeHtml(member.family_name)}`:""}${member.big_unique_id?`<br><strong>Known Big ID:</strong> ${escapeHtml(member.big_unique_id)}`:""}</p><h3>Submitted by</h3><p>${escapeHtml(submitterName)}<br>${escapeHtml(submitterEmail)}${relationship?`<br>${escapeHtml(relationship)}`:""}</p><h3>Information provided</h3><p style="white-space:pre-wrap">${escapeHtml(information)}</p>${source?`<h3>Source or Evidence</h3><p style="white-space:pre-wrap">${escapeHtml(source)}</p>`:""}<p style="color:#666;font-size:12px">Submitted ${escapeHtml(submittedAt)}. Replying to this message will address the submitter.</p>`);

        const internal=await sendTransactionalEmail(env,{to:recipients,subject,text,html,replyTo:submitterEmail,fromName:"Zeta Kappa Website"},{category:"family_tree_information",entityType:"family_tree_member",entityId:memberId,authUsername:env.NOREPLY_SMTP_USERNAME,authPassword:env.NOREPLY_SMTP_PASSWORD});
        if(!internal.ok) return json({ok:false,error:"We could not deliver your information to the website administrators. Please try again."},502,headers);

        const confirmSubject="Thank You for Helping Preserve Zeta Kappa History";
        const confirmText=[`Hello ${submitterName},`,"",`Thank you for providing information about ${memberName} (${memberId}), a Brother Lost to Time in the Zeta Kappa Family Tree.`,"","Your submission has been received and forwarded to the website administrators for review. They will review the information and any sources you provided and update the Family Tree when appropriate.","","Preserving Zeta Kappa's history depends in part on alumni, family members, and friends helping us fill gaps in our records. We appreciate you taking the time to help.","","Theta Chi Fraternity — Zeta Kappa Chapter","Family Tree & Chapter History","","This is an automated message from tczk.org. Please do not reply to this email."].join("\n");
        const confirmHtml=adminEmailTemplate("Thank You for Helping Preserve Zeta Kappa History",`<p>Hello ${escapeHtml(submitterName)},</p><p>Thank you for providing information about <strong>${escapeHtml(memberName)}</strong> (${escapeHtml(memberId)}), a Brother Lost to Time in the Zeta Kappa Family Tree.</p><p>Your submission has been received and forwarded to the website administrators for review. They will review the information and any sources you provided and update the Family Tree when appropriate.</p><p>Preserving Zeta Kappa's history depends in part on alumni, family members, and friends helping us fill gaps in our records. We appreciate you taking the time to help.</p><p><strong>Theta Chi Fraternity — Zeta Kappa Chapter</strong><br>Family Tree &amp; Chapter History</p>`);
        const confirmation=await sendTransactionalEmail(env,{to:submitterEmail,subject:confirmSubject,text:confirmText,html:confirmHtml,fromName:"Zeta Kappa Website"},{category:"family_tree_information_confirmation",entityType:"family_tree_member",entityId:memberId,authUsername:env.NOREPLY_SMTP_USERNAME,authPassword:env.NOREPLY_SMTP_PASSWORD});
        return json({ok:true,received:true,confirmationSent:!!confirmation.ok},200,headers);
      }


      // Chapter History submissions: public intake + authenticated review.
      const historyPath=url.pathname.replace(/\/+$/,"")||"/";

      if (historyPath === "/api/public/chapter-history" && request.method === "GET") {
        return json({ok:true,endpoint:"chapter-history",method:"POST",storageConfigured:Boolean(env.HISTORY_UPLOADS),emailConfigured:Boolean(env.NOREPLY_SMTP_USERNAME&&env.NOREPLY_SMTP_PASSWORD),maxUploadBytes:104857600},200,headers);
      }

      if (historyPath === "/api/public/chapter-history" && request.method === "POST") {
        if(!allowedOrigins.has(origin)) return json({ok:false,error:"Origin not allowed."},403,headers);
        if(!env.HISTORY_UPLOADS) return json({ok:false,error:"Historical file storage is not configured."},503,headers);
        const contentType=String(request.headers.get("content-type")||"");
        if(!contentType.toLowerCase().includes("multipart/form-data")) return json({ok:false,error:"Historical submissions must use multipart form data."},400,headers);

        const form=await request.formData();
        if(String(form.get("website")||"").trim()) return json({ok:true,received:true},200,headers);
        const submitterName=String(form.get("submitterName")||"").trim().slice(0,120);
        const submitterEmail=normalizeEmail(form.get("submitterEmail")||"");
        const category=String(form.get("category")||"").trim().slice(0,120);
        const historicalDate=String(form.get("historicalDate")||"").trim().slice(0,80);
        const description=String(form.get("description")||"").trim().slice(0,5000);
        if(submitterName.length<2) return json({ok:false,error:"Please enter your name."},400,headers);
        if(!isEmail(submitterEmail)) return json({ok:false,error:"Please enter a valid email address."},400,headers);
        if(!category) return json({ok:false,error:"Please select what you are sharing."},400,headers);
        if(description.length<5) return json({ok:false,error:"Please describe the historical material."},400,headers);

        const allowedExt=new Set(["zip","pdf","doc","docx","txt","rtf","md","csv","xls","xlsx","ppt","pptx","jpg","jpeg","png","webp"]);
        const files=form.getAll("files").filter(v=>v&&typeof v==="object"&&typeof v.arrayBuffer==="function"&&v.name);
        let totalBytes=0;
        for(const f of files){
          totalBytes+=Number(f.size)||0;
          const ext=String(f.name||"").split(".").pop().toLowerCase();
          if(!allowedExt.has(ext)) return json({ok:false,error:`File type .${ext||"unknown"} is not accepted.`},400,headers);
        }
        if(totalBytes>104857600) return json({ok:false,error:"Historical submissions are limited to 100 MB total."},413,headers);

        const publicId=`HIST-${crypto.randomUUID()}`;
        const created=await env.DB.prepare(`INSERT INTO chapter_history_submissions (public_id,submitter_name,submitter_email,category,historical_date,description,status,created_at,updated_at) VALUES (?,?,?,?,?,?,'new',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP) RETURNING id`).bind(publicId,submitterName,submitterEmail,category,historicalDate||null,description).first();
        const submissionId=Number(created?.id);
        const stored=[];
        try{
          for(const f of files){
            const safeName=historySafeFilename(f.name);
            const objectKey=`chapter-history/${publicId}/${crypto.randomUUID()}-${safeName}`;
            await env.HISTORY_UPLOADS.put(objectKey,await f.arrayBuffer(),{httpMetadata:{contentType:String(f.type||"application/octet-stream")},customMetadata:{submission:publicId,originalName:String(f.name).slice(0,240)}});
            await env.DB.prepare(`INSERT INTO chapter_history_submission_files (submission_id,object_key,original_filename,content_type,size_bytes) VALUES (?,?,?,?,?)`).bind(submissionId,objectKey,String(f.name).slice(0,240),String(f.type||"application/octet-stream").slice(0,160),Number(f.size)||0).run();
            stored.push({objectKey,name:String(f.name).slice(0,240),size:Number(f.size)||0});
          }
        }catch(err){
          for(const f of stored){try{await env.HISTORY_UPLOADS.delete(f.objectKey);}catch{}}
          await env.DB.prepare(`DELETE FROM chapter_history_submissions WHERE id=?`).bind(submissionId).run();
          throw err;
        }

        let notificationSent=false,confirmationSent=false;
        if(env.NOREPLY_SMTP_USERNAME&&env.NOREPLY_SMTP_PASSWORD){
          const p1=(await env.DB.prepare(`SELECT email FROM admin_users WHERE active=1 AND priority=1 AND deleted_at IS NULL ORDER BY lower(email)`).all()).results||[];
          const recipients=[...new Set(["admin@tczk.org",...p1.map(r=>normalizeEmail(r.email)).filter(isEmail)].map(normalizeEmail).filter(isEmail))];
          const fileSummary=stored.length?stored.map(f=>`${f.name} (${historyFormatBytes(f.size)})`).join("\n"):"No files attached.";
          const subject=`New Chapter History Submission — ${publicId}`.slice(0,300);
          const text=[`A new Zeta Kappa chapter-history submission is waiting for review.`,"",`Submission: ${publicId}`,`Category: ${category}`,historicalDate?`Approximate date: ${historicalDate}`:"",`Submitted by: ${submitterName}`,`Email: ${submitterEmail}`,"",description,"","Files:",fileSummary,"","Review this submission in the website Admin Panel."].filter(Boolean).join("\n");
          const html=adminEmailTemplate("New Chapter History Submission",`<p>A new Zeta Kappa chapter-history submission is waiting for review.</p><p><strong>Submission:</strong> ${escapeHtml(publicId)}<br><strong>Category:</strong> ${escapeHtml(category)}${historicalDate?`<br><strong>Approximate date:</strong> ${escapeHtml(historicalDate)}`:""}<br><strong>Submitted by:</strong> ${escapeHtml(submitterName)}<br><strong>Email:</strong> ${escapeHtml(submitterEmail)}</p><h3>Description</h3><p style="white-space:pre-wrap">${escapeHtml(description)}</p><h3>Files</h3><p style="white-space:pre-wrap">${escapeHtml(fileSummary)}</p><p>Review this submission in the website Admin Panel.</p>`);
          const notice=await sendTransactionalEmail(env,{to:recipients,subject,text,html,replyTo:submitterEmail,fromName:"Zeta Kappa Website"},{category:"chapter_history_submission",entityType:"chapter_history_submission",entityId:publicId,authUsername:env.NOREPLY_SMTP_USERNAME,authPassword:env.NOREPLY_SMTP_PASSWORD});
          notificationSent=!!notice.ok;
          const confirmText=[`Hello ${submitterName},`,"","Thank you for helping preserve the history of Theta Chi's Zeta Kappa Chapter.",`Your submission (${publicId}) has been received and will be reviewed by the website administrators. Historical records and files will be incorporated when appropriate.`,"","Theta Chi Fraternity — Zeta Kappa Chapter","Chapter History","","This is an automated message from tczk.org. Please do not reply."].join("\n");
          const confirmHtml=adminEmailTemplate("Thank You for Helping Preserve Zeta Kappa History",`<p>Hello ${escapeHtml(submitterName)},</p><p>Thank you for helping preserve the history of Theta Chi's Zeta Kappa Chapter.</p><p>Your submission <strong>${escapeHtml(publicId)}</strong> has been received and will be reviewed by the website administrators. Historical records and files will be incorporated when appropriate.</p><p><strong>Theta Chi Fraternity — Zeta Kappa Chapter</strong><br>Chapter History</p>`);
          const confirmation=await sendTransactionalEmail(env,{to:submitterEmail,subject:"Thank You for Helping Preserve Zeta Kappa History",text:confirmText,html:confirmHtml,fromName:"Zeta Kappa Website"},{category:"chapter_history_confirmation",entityType:"chapter_history_submission",entityId:publicId,authUsername:env.NOREPLY_SMTP_USERNAME,authPassword:env.NOREPLY_SMTP_PASSWORD});
          confirmationSent=!!confirmation.ok;
        }
        return json({ok:true,received:true,submissionId:publicId,fileCount:stored.length,notificationSent,confirmationSent},201,headers);
      }

      if (historyPath === "/api/admin/chapter-history" && request.method === "GET") {
        const admin=await requireAdmin(request,env);
        if(!admin) return json({ok:false,error:"Administrator access required."},403,headers);
        const rows=(await env.DB.prepare(`SELECT s.*,COUNT(f.id) AS file_count,COALESCE(SUM(f.size_bytes),0) AS total_bytes FROM chapter_history_submissions s LEFT JOIN chapter_history_submission_files f ON f.submission_id=s.id GROUP BY s.id ORDER BY CASE s.status WHEN 'new' THEN 0 WHEN 'reviewing' THEN 1 WHEN 'acted_upon' THEN 2 ELSE 3 END,s.created_at DESC LIMIT 250`).all()).results||[];
        return json({ok:true,submissions:rows.map(historySubmissionJson)},200,headers);
      }

      const historyMatch=historyPath.match(/^\/api\/admin\/chapter-history\/([^/]+)$/);
      if(historyMatch && request.method==="GET"){
        const admin=await requireAdmin(request,env);
        if(!admin) return json({ok:false,error:"Administrator access required."},403,headers);
        const publicId=decodeURIComponent(historyMatch[1]);
        const row=await env.DB.prepare(`SELECT * FROM chapter_history_submissions WHERE public_id=? LIMIT 1`).bind(publicId).first();
        if(!row) return json({ok:false,error:"Historical submission not found."},404,headers);
        const files=(await env.DB.prepare(`SELECT id,original_filename,content_type,size_bytes,created_at FROM chapter_history_submission_files WHERE submission_id=? ORDER BY id`).bind(row.id).all()).results||[];
        return json({ok:true,submission:historySubmissionJson(row),files:files.map(historyFileJson)},200,headers);
      }

      if(historyMatch && request.method==="PATCH"){
        const admin=await requireAdmin(request,env);
        if(!admin) return json({ok:false,error:"Administrator access required."},403,headers);
        const publicId=decodeURIComponent(historyMatch[1]),body=await safeJson(request);
        if(!body) return json({ok:false,error:"Invalid JSON body."},400,headers);
        const current=await env.DB.prepare(`SELECT * FROM chapter_history_submissions WHERE public_id=? LIMIT 1`).bind(publicId).first();
        if(!current) return json({ok:false,error:"Historical submission not found."},404,headers);
        const allowedStatus=new Set(["new","reviewing","acted_upon","rejected"]);
        const status=body.status===undefined?current.status:String(body.status);
        if(!allowedStatus.has(status)) return json({ok:false,error:"Invalid review status."},400,headers);
        const notes=body.reviewNotes===undefined?String(current.review_notes||""):String(body.reviewNotes||"").trim().slice(0,5000);
        const actor=String(admin.display_name||admin.email||admin.user_id);
        await env.DB.prepare(`UPDATE chapter_history_submissions SET status=?,review_notes=?,reviewed_by=?,reviewed_at=CURRENT_TIMESTAMP,acted_upon_at=CASE WHEN ?='acted_upon' THEN COALESCE(acted_upon_at,CURRENT_TIMESTAMP) ELSE acted_upon_at END,updated_at=CURRENT_TIMESTAMP WHERE id=?`).bind(status,notes||null,actor,status,current.id).run();
        await writeAudit(env,admin.user_id,"chapter_history_reviewed","chapter_history_submission",publicId,{status});
        const updated=await env.DB.prepare(`SELECT * FROM chapter_history_submissions WHERE id=?`).bind(current.id).first();
        return json({ok:true,submission:historySubmissionJson(updated)},200,headers);
      }

      const historyFileMatch=historyPath.match(/^\/api\/admin\/chapter-history\/([^/]+)\/files\/(\d+)$/);
      if(historyFileMatch && request.method==="GET"){
        const admin=await requireAdmin(request,env);
        if(!admin) return json({ok:false,error:"Administrator access required."},403,headers);
        if(!env.HISTORY_UPLOADS) return json({ok:false,error:"Historical file storage is not configured."},503,headers);
        const publicId=decodeURIComponent(historyFileMatch[1]),fileId=Number(historyFileMatch[2]);
        const f=await env.DB.prepare(`SELECT f.* FROM chapter_history_submission_files f JOIN chapter_history_submissions s ON s.id=f.submission_id WHERE s.public_id=? AND f.id=? LIMIT 1`).bind(publicId,fileId).first();
        if(!f) return json({ok:false,error:"Historical file not found."},404,headers);
        const obj=await env.HISTORY_UPLOADS.get(f.object_key);
        if(!obj) return json({ok:false,error:"Stored historical file is missing."},404,headers);
        const dh=new Headers();dh.set("Content-Type",f.content_type||"application/octet-stream");dh.set("Content-Disposition",`attachment; filename="${historyDownloadFilename(f.original_filename)}"`);dh.set("Cache-Control","private, no-store");
        return new Response(obj.body,{status:200,headers:dh});
      }

      if(historyMatch && request.method==="DELETE"){
        const admin=await requirePrimaryAdmin(request,env);
        if(!admin) return json({ok:false,error:"Primary Admin access required for permanent deletion."},403,headers);
        if(!env.HISTORY_UPLOADS) return json({ok:false,error:"Historical file storage is not configured."},503,headers);
        const publicId=decodeURIComponent(historyMatch[1]),body=await safeJson(request);
        if(!body) return json({ok:false,error:"A deletion reason is required."},400,headers);
        const reason=String(body.reason||"").trim().slice(0,500);
        if(reason.length<3) return json({ok:false,error:"Enter a deletion reason."},400,headers);
        const row=await env.DB.prepare(`SELECT * FROM chapter_history_submissions WHERE public_id=? LIMIT 1`).bind(publicId).first();
        if(!row) return json({ok:false,error:"Historical submission not found."},404,headers);
        if(row.status!=="acted_upon" && !body.override) return json({ok:false,error:"Mark this submission Acted Upon before deletion, or explicitly use the P1 exception for spam, duplicates, or accidental submissions."},409,headers);
        const files=(await env.DB.prepare(`SELECT object_key FROM chapter_history_submission_files WHERE submission_id=?`).bind(row.id).all()).results||[];
        for(const f of files){await env.HISTORY_UPLOADS.delete(f.object_key);}
        const actor=String(admin.display_name||admin.email||admin.user_id);
        await env.DB.batch([
          env.DB.prepare(`INSERT INTO chapter_history_deletion_audit (submission_public_id,deleted_by,deletion_reason,prior_status,deleted_file_count) VALUES (?,?,?,?,?)`).bind(publicId,actor,reason,row.status,files.length),
          env.DB.prepare(`DELETE FROM chapter_history_submission_files WHERE submission_id=?`).bind(row.id),
          env.DB.prepare(`DELETE FROM chapter_history_submissions WHERE id=?`).bind(row.id)
        ]);
        await writeAudit(env,admin.user_id,"chapter_history_deleted","chapter_history_submission",publicId,{reason,priorStatus:row.status,fileCount:files.length,override:Boolean(body.override)});
        return json({ok:true,deleted:true,submissionId:publicId,deletedFileCount:files.length},200,headers);
      }

      // Read-only public dataset for the future viewer. No admin-only notes are
      // returned here; notes remain available only through authenticated routes.
      if (url.pathname === "/api/public/family-tree" && request.method === "GET") {
        const families=(await env.DB.prepare(`
          SELECT code,name,id_prefix,display_order
          FROM family_tree_families
          WHERE active=1
          ORDER BY display_order ASC,lower(name)
        `).all()).results||[];

        const members=(await env.DB.prepare(`
          SELECT m.unique_id,m.name,m.sort_last_name,m.roster_number,m.member_type,
                 m.family_code,m.big_unique_id,m.founding_father,m.initiated_year,
                 m.graduation_year,f.name AS family_name,b.name AS big_name
          FROM family_tree_members m
          LEFT JOIN family_tree_families f ON f.code=m.family_code
          LEFT JOIN family_tree_members b ON b.unique_id=m.big_unique_id
          ORDER BY m.roster_number ASC,lower(m.name)
        `).all()).results||[];

        return json({
          ok:true,
          families:families.map(mapFamilyTreeFamily),
          members:members.map(mapPublicFamilyTreeMember)
        },200,{...headers,"Cache-Control":"public, max-age=300"});
      }




      // Legacy hardcoded Spring Formal registration retired in v29.3.

      // Forms Builder v24 (draft, preview, lifecycle, and public rendering) --------
      if (url.pathname === "/api/admin/forms" && request.method === "GET") {
        const session=await requireSession(request,env);if(!session)return json({ok:false,error:"Admin session required."},403,headers);
        const rows=await env.DB.prepare(`SELECT f.*,(SELECT COUNT(*) FROM form_questions q WHERE q.form_id=f.id) AS question_count,(SELECT COUNT(*) FROM form_responses r WHERE r.form_id=f.id) AS response_count FROM forms f ORDER BY f.updated_at DESC,f.created_at DESC`).all();
        return json({ok:true,forms:(rows.results||[]).map(mapFormListRow)},200,headers);
      }

      if (url.pathname === "/api/admin/forms" && request.method === "POST") {
        const session=await requireSession(request,env);if(!session)return json({ok:false,error:"Admin session required."},403,headers);
        const body=await safeJson(request);if(!body)return json({ok:false,error:"Invalid JSON body."},400,headers);
        const formType=String(body.formType||"").trim().toLowerCase();
        if(!["survey","registration"].includes(formType))return json({ok:false,error:"Form type must be survey or registration."},400,headers);
        const title=String(body.title||"").trim().slice(0,180);const slug=safeFormSlug(body.slug||title);
        if(!title||!slug)return json({ok:false,error:"Title and slug are required."},400,headers);
        const existing=await env.DB.prepare(`SELECT id FROM forms WHERE slug=? LIMIT 1`).bind(slug).first();if(existing)return json({ok:false,error:"That form slug is already in use."},409,headers);
        const id=crypto.randomUUID();
        await env.DB.prepare(`INSERT INTO forms (id,slug,form_type,title,status,created_by,created_at,updated_at) VALUES (?,?,?,?,'draft',?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`).bind(id,slug,formType,title,session.user_id).run();
        if(formType==="registration")await env.DB.prepare(`INSERT OR IGNORE INTO registration_square_settings (form_id) VALUES (?)`).bind(id).run();
        await writeAudit(env,session.user_id,"form_draft_created","form",id,{formType,title,slug});
        return json({ok:true,form:await getFormBuilderBundle(env,id)},201,headers);
      }

      const formBuilderMatch=url.pathname.match(/^\/api\/admin\/forms\/([^/]+)$/);
      if(formBuilderMatch && request.method==="GET"){
        const session=await requireSession(request,env);if(!session)return json({ok:false,error:"Admin session required."},403,headers);
        const id=decodeURIComponent(formBuilderMatch[1]),form=await getFormBuilderBundle(env,id);if(!form)return json({ok:false,error:"Form not found."},404,headers);
        return json({ok:true,form},200,headers);
      }

      if(formBuilderMatch && request.method==="PUT"){
        const session=await requireSession(request,env);if(!session)return json({ok:false,error:"Admin session required."},403,headers);
        const id=decodeURIComponent(formBuilderMatch[1]),existing=await env.DB.prepare(`SELECT * FROM forms WHERE id=? LIMIT 1`).bind(id).first();if(!existing)return json({ok:false,error:"Form not found."},404,headers);
        if(existing.status!=="draft")return json({ok:false,error:"Only draft forms can be edited. Unpublish or duplicate this form first."},409,headers);
        const priorResponse=await env.DB.prepare(`SELECT id FROM form_responses WHERE form_id=? LIMIT 1`).bind(id).first();if(priorResponse)return json({ok:false,error:"This form already has responses. Duplicate it to make structural changes without destroying response data."},409,headers);
        const body=await safeJson(request);if(!body)return json({ok:false,error:"Invalid JSON body."},400,headers);
        const title=String(body.title||"").trim().slice(0,180),slug=safeFormSlug(body.slug||title),description=String(body.description||"").trim().slice(0,5000);
        if(!title||!slug)return json({ok:false,error:"Title and slug are required."},400,headers);
        const duplicate=await env.DB.prepare(`SELECT id FROM forms WHERE slug=? AND id<>? LIMIT 1`).bind(slug,id).first();if(duplicate)return json({ok:false,error:"That form slug is already in use."},409,headers);
        const questions=Array.isArray(body.questions)?body.questions.slice(0,100):[];const seen=new Set(),qRows=[];
        for(let i=0;i<questions.length;i++){
          const q=questions[i]||{},qid=String(q.id||crypto.randomUUID()).slice(0,120),key=safeQuestionKey(q.key||`question_${i+1}`),label=String(q.label||"").trim().slice(0,500),type=String(q.type||"text").trim();
          if(!key||seen.has(key))return json({ok:false,error:`Question keys must be unique. Check: ${key||'(blank)'}`},400,headers);seen.add(key);
          if(!FORM_QUESTION_TYPES.has(type))return json({ok:false,error:`Unsupported question type: ${type}`},400,headers);
          if(!label)return json({ok:false,error:`Question ${i+1} needs a label.`},400,headers);
          const opts=Array.isArray(q.options)?q.options.map(x=>String(x||"").trim()).filter(Boolean).slice(0,100):[];
          const cond=q.conditional&&typeof q.conditional==='object'?{questionKey:safeQuestionKey(q.conditional.questionKey||''),operator:String(q.conditional.operator||'equals').slice(0,30),value:String(q.conditional.value||'').slice(0,500)}:null;
          qRows.push({id:qid,key,label,type,helpText:String(q.helpText||"").trim().slice(0,1000),options:opts,required:!['section','info'].includes(type)&&Boolean(q.required),conditional:cond?.questionKey?cond:null,order:Number(q.order)||((i+1)*10)});
        }
        const statements=[env.DB.prepare(`UPDATE forms SET slug=?,title=?,description=?,opens_at=?,closes_at=?,allow_multiple=?,event_date=?,public_path=?,status='draft',updated_at=CURRENT_TIMESTAMP WHERE id=?`).bind(slug,title,description,cleanNullableDate(body.opensAt),cleanNullableDate(body.closesAt),body.allowMultiple?1:0,String(body.eventDate||"").trim().slice(0,20)||null,String(body.publicPath||"").trim().slice(0,300),id),env.DB.prepare(`DELETE FROM form_questions WHERE form_id=?`).bind(id)];
        for(const q of qRows)statements.push(env.DB.prepare(`INSERT INTO form_questions (id,form_id,question_key,label,help_text,question_type,options_json,conditional_json,required,display_order,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)`).bind(q.id,id,q.key,q.label,q.helpText,q.type,q.options.length?JSON.stringify(q.options):null,q.conditional?JSON.stringify(q.conditional):null,q.required?1:0,q.order));
        if(existing.form_type==="registration"){
          const sq=body.square&&typeof body.square==="object"?body.square:{};statements.push(env.DB.prepare(`INSERT INTO registration_square_settings (form_id,item_name,item_id,validation_status,validation_message,last_validated_at,allow_check,check_instructions,updated_at) VALUES (?,?,NULL,'not_validated','',NULL,?,?,CURRENT_TIMESTAMP) ON CONFLICT(form_id) DO UPDATE SET item_name=excluded.item_name,item_id=NULL,validation_status='not_validated',validation_message='',last_validated_at=NULL,allow_check=excluded.allow_check,check_instructions=excluded.check_instructions,updated_at=CURRENT_TIMESTAMP`).bind(id,String(sq.itemName||"").trim().slice(0,300),sq.allowCheck?1:0,String(sq.checkInstructions||'').trim().slice(0,2000)));
          statements.push(env.DB.prepare(`DELETE FROM registration_square_variations WHERE form_id=?`).bind(id));
          statements.push(env.DB.prepare(`DELETE FROM registration_square_modifier_sets WHERE form_id=?`).bind(id));
          const vars=Array.isArray(sq.variations)?sq.variations.slice(0,100):[];
          for(let i=0;i<vars.length;i++){const v=vars[i]||{};statements.push(env.DB.prepare(`INSERT INTO registration_square_variations (id,form_id,internal_label,square_name,square_variation_id,expected_price_cents,pricing_phase,trigger_question_key,trigger_value,active_from,active_until,display_order,validation_status) VALUES (?,?,?,?,NULL,?,?,?,?,?,?,?,'not_validated')`).bind(String(v.id||crypto.randomUUID()).slice(0,120),id,String(v.internalLabel||"").trim().slice(0,200),String(v.squareName||"").trim().slice(0,300),toNullableCents(v.expectedPriceCents),String(v.pricingPhase||"standard").trim().slice(0,40)||"standard",safeQuestionKey(v.triggerQuestionKey||''),String(v.triggerValue||'').trim().slice(0,500),cleanNullableDate(v.activeFrom),cleanNullableDate(v.activeUntil),Number(v.order)||((i+1)*10)));}
          const sets=Array.isArray(sq.modifierSets)?sq.modifierSets.slice(0,50):[];
          for(let i=0;i<sets.length;i++){const ms=sets[i]||{},msid=String(ms.id||crypto.randomUUID()).slice(0,120);statements.push(env.DB.prepare(`INSERT INTO registration_square_modifier_sets (id,form_id,internal_purpose,square_name,square_modifier_set_id,display_order,validation_status) VALUES (?,?,?,?,NULL,?,'not_validated')`).bind(msid,id,String(ms.internalPurpose||"").trim().slice(0,200),String(ms.squareName||"").trim().slice(0,300),Number(ms.order)||((i+1)*10)));const mods=Array.isArray(ms.modifiers)?ms.modifiers.slice(0,100):[];for(let j=0;j<mods.length;j++){const m=mods[j]||{};statements.push(env.DB.prepare(`INSERT INTO registration_square_modifiers (id,modifier_set_id,internal_label,square_name,square_modifier_id,expected_price_cents,trigger_question_key,trigger_value,active_from,active_until,display_order,validation_status) VALUES (?,?,?,?,NULL,?,?,?,?,?,?,'not_validated')`).bind(String(m.id||crypto.randomUUID()).slice(0,120),msid,String(m.internalLabel||"").trim().slice(0,200),String(m.squareName||"").trim().slice(0,300),toNullableCents(m.expectedPriceCents),safeQuestionKey(m.triggerQuestionKey||''),String(m.triggerValue||'').trim().slice(0,500),cleanNullableDate(m.activeFrom),cleanNullableDate(m.activeUntil),Number(m.order)||((j+1)*10)));}}
        }
        await env.DB.batch(statements);await writeAudit(env,session.user_id,"form_draft_updated","form",id,{title,slug,questions:qRows.length});
        return json({ok:true,form:await getFormBuilderBundle(env,id)},200,headers);
      }


      const formLifecycleMatch=url.pathname.match(/^\/api\/admin\/forms\/([^/]+)\/(duplicate|publish|unpublish|close|archive)$/);
      if(formLifecycleMatch && request.method==="POST"){
        const id=decodeURIComponent(formLifecycleMatch[1]),action=formLifecycleMatch[2];
        const session=action==="duplicate"?await requireSession(request,env):await requireAdmin(request,env);
        if(!session)return json({ok:false,error:action==="duplicate"?"Admin session required.":"Administrator access required to change publication status."},403,headers);
        const source=await getFormBuilderBundle(env,id);if(!source)return json({ok:false,error:"Form not found."},404,headers);
        if(action==="duplicate"){
          const newId=crypto.randomUUID(),suffix=newId.slice(0,8),newSlug=safeFormSlug(`${source.slug}-copy-${suffix}`),newTitle=`Copy of ${source.title}`.slice(0,180);
          const stmts=[env.DB.prepare(`INSERT INTO forms (id,slug,form_type,title,description,status,opens_at,closes_at,allow_multiple,event_date,public_path,created_by,created_at,updated_at) VALUES (?,?,?,?,?,'draft',?,?,?,?,?,?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`).bind(newId,newSlug,source.formType,newTitle,source.description||'',source.opensAt||null,source.closesAt||null,source.allowMultiple?1:0,source.eventDate||null,`/forms/?form=${newSlug}`,session.user_id)];
          for(let i=0;i<(source.questions||[]).length;i++){const q=source.questions[i];stmts.push(env.DB.prepare(`INSERT INTO form_questions (id,form_id,question_key,label,help_text,question_type,options_json,conditional_json,required,display_order,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)`).bind(crypto.randomUUID(),newId,q.key,q.label,q.helpText||'',q.type,(q.options||[]).length?JSON.stringify(q.options):null,q.conditional?JSON.stringify(q.conditional):null,q.required?1:0,Number(q.order)||((i+1)*10)));}
          if(source.formType==="registration"){
            const sq=source.square||{};stmts.push(env.DB.prepare(`INSERT INTO registration_square_settings (form_id,item_name,item_id,validation_status,validation_message,last_validated_at,allow_check,check_instructions,updated_at) VALUES (?,?,NULL,'not_validated','',NULL,?,?,CURRENT_TIMESTAMP)`).bind(newId,sq.itemName||'',sq.allowCheck?1:0,sq.checkInstructions||''));
            for(let i=0;i<(sq.variations||[]).length;i++){const v=sq.variations[i];stmts.push(env.DB.prepare(`INSERT INTO registration_square_variations (id,form_id,internal_label,square_name,square_variation_id,expected_price_cents,pricing_phase,trigger_question_key,trigger_value,active_from,active_until,display_order,validation_status) VALUES (?,?,?,?,NULL,?,?,?,?,?,?,?,'not_validated')`).bind(crypto.randomUUID(),newId,v.internalLabel||'',v.squareName||'',toNullableCents(v.expectedPriceCents),v.pricingPhase||'standard',safeQuestionKey(v.triggerQuestionKey||''),v.triggerValue||'',v.activeFrom||null,v.activeUntil||null,Number(v.order)||((i+1)*10)));}
            for(let i=0;i<(sq.modifierSets||[]).length;i++){const ms=sq.modifierSets[i],msid=crypto.randomUUID();stmts.push(env.DB.prepare(`INSERT INTO registration_square_modifier_sets (id,form_id,internal_purpose,square_name,square_modifier_set_id,display_order,validation_status) VALUES (?,?,?,?,NULL,?,'not_validated')`).bind(msid,newId,ms.internalPurpose||'',ms.squareName||'',Number(ms.order)||((i+1)*10)));for(let j=0;j<(ms.modifiers||[]).length;j++){const m=ms.modifiers[j];stmts.push(env.DB.prepare(`INSERT INTO registration_square_modifiers (id,modifier_set_id,internal_label,square_name,square_modifier_id,expected_price_cents,trigger_question_key,trigger_value,active_from,active_until,display_order,validation_status) VALUES (?,?,?,?,NULL,?,?,?,?,?,?,'not_validated')`).bind(crypto.randomUUID(),msid,m.internalLabel||'',m.squareName||'',toNullableCents(m.expectedPriceCents),safeQuestionKey(m.triggerQuestionKey||''),String(m.triggerValue||'').trim().slice(0,500),cleanNullableDate(m.activeFrom),cleanNullableDate(m.activeUntil),Number(m.order)||((j+1)*10)));}}
          }
          await env.DB.batch(stmts);await writeAudit(env,session.user_id,"form_duplicated","form",newId,{sourceId:id,slug:newSlug});return json({ok:true,form:await getFormBuilderBundle(env,newId)},201,headers);
        }
        if(action==="publish"){
          if(source.status!=="draft"&&source.status!=="closed")return json({ok:false,error:"Only draft or closed forms can be published."},409,headers);
          if(!(source.questions||[]).length)return json({ok:false,error:"Add at least one question or information field before publishing."},400,headers);
          const opens=source.opensAt?Date.parse(source.opensAt):NaN,closes=source.closesAt?Date.parse(source.closesAt):NaN;if(Number.isFinite(opens)&&Number.isFinite(closes)&&closes<=opens)return json({ok:false,error:"Close date/time must be after open date/time."},400,headers);
          if(source.formType==="registration"&&(!(source.square?.variations||[]).length||source.square?.validationStatus!=="valid"))return json({ok:false,error:"Registration forms need at least one variation and a fully validated Square configuration before publishing."},409,headers);
          const publicPath=source.publicPath||`/forms/?form=${source.slug}`;await env.DB.prepare(`UPDATE forms SET status='open',public_path=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`).bind(publicPath,id).run();await writeAudit(env,session.user_id,"form_published","form",id,{slug:source.slug,formType:source.formType});return json({ok:true,form:await getFormBuilderBundle(env,id)},200,headers);
        }
        const newStatus=action==="unpublish"?'draft':action==="close"?'closed':'archived';await env.DB.prepare(`UPDATE forms SET status=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`).bind(newStatus,id).run();const auditAction=action==='unpublish'?'form_unpublished':action==='close'?'form_closed':'form_archived';await writeAudit(env,session.user_id,auditAction,"form",id,{priorStatus:source.status,newStatus});return json({ok:true,form:await getFormBuilderBundle(env,id)},200,headers);
      }

      const squareValidateMatch=url.pathname.match(/^\/api\/admin\/forms\/([^/]+)\/square\/validate$/);
      if(squareValidateMatch && request.method==="POST"){
        const session=await requireSession(request,env);if(!session)return json({ok:false,error:"Admin session required."},403,headers);
        const id=decodeURIComponent(squareValidateMatch[1]),bundle=await getFormBuilderBundle(env,id);if(!bundle)return json({ok:false,error:"Form not found."},404,headers);if(bundle.formType!=="registration")return json({ok:false,error:"Square validation only applies to registration forms."},400,headers);
        if(!env.SQUARE_ACCESS_TOKEN||!env.SQUARE_LOCATION_ID)return json({ok:false,error:"Square is not configured in this Worker environment."},503,headers);
        const sq=bundle.square||{},itemName=String(sq.itemName||"").trim();if(!itemName)return json({ok:false,error:"Enter the Square product/item name first."},400,headers);
        let item;try{item=await findSquareItemDetailed(env,itemName);}catch(err){return json({ok:false,error:err?.message||'Square item lookup failed.'},502,headers);}const updates=[];let validCount=0,totalCount=1;let itemStatus=item?'valid':'invalid';
        if(item)validCount++;updates.push(env.DB.prepare(`UPDATE registration_square_settings SET item_id=?,validation_status=?,validation_message=?,last_validated_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE form_id=?`).bind(item?.id||null,itemStatus,item?"Square item found.":"Square item was not found by exact name.",id));
        for(const v of sq.variations||[]){totalCount++;const match=item?.variations?.find(x=>x?.item_variation_data?.name===v.squareName&&!x?.is_deleted)||null;let status=match?'valid':'missing';const actual=match?.item_variation_data?.price_money?.amount; if(match&&v.expectedPriceCents!=null&&actual!=null&&Number(actual)!==Number(v.expectedPriceCents))status='price_mismatch';if(status==='valid')validCount++;updates.push(env.DB.prepare(`UPDATE registration_square_variations SET square_variation_id=?,validation_status=? WHERE id=? AND form_id=?`).bind(match?.id||null,status,v.id,id));}
        const details=[{kind:'item',name:itemName,status:itemStatus,message:item?'Item found by exact name.':'Item not found by exact name.'}];
        for(const v of sq.variations||[]){const match=item?.variations?.find(x=>x?.item_variation_data?.name===v.squareName&&!x?.is_deleted)||null;let st=match?'valid':'missing';const actual=match?.item_variation_data?.price_money?.amount;if(match&&v.expectedPriceCents!=null&&actual!=null&&Number(actual)!==Number(v.expectedPriceCents))st='price_mismatch';details.push({kind:'variation',name:v.squareName,status:st,message:st==='valid'?'Variation found.':st==='price_mismatch'?`Variation found, but Square price is $${(Number(actual)/100).toFixed(2)} instead of $${(Number(v.expectedPriceCents)/100).toFixed(2)}.`:'Variation not found under the configured item.'});}
        for(const ms of sq.modifierSets||[]){let detail;try{detail=await findSquareModifierListDetailed(env,ms.squareName);}catch(err){return json({ok:false,error:err?.message||`Square modifier lookup failed for ${ms.squareName}.`},502,headers);}const setFound=!!detail?.list;totalCount++;if(setFound)validCount++;updates.push(env.DB.prepare(`UPDATE registration_square_modifier_sets SET square_modifier_set_id=?,validation_status=? WHERE id=? AND form_id=?`).bind(detail?.list?.id||null,setFound?'valid':'missing',ms.id,id));const canonicalSetName=detail?.list?.modifier_list_data?.name||'';const suggestionText=(detail?.suggestions||[]).map(x=>x.name).filter(Boolean);let setMessage;if(setFound){setMessage=detail.matchType==='normalized'?`Matched after punctuation/spacing normalization to Square modifier set “${canonicalSetName}” (${detail.modifiers.length} modifier${detail.modifiers.length===1?'':'s'} retrieved).`:`Modifier set found (${detail.modifiers.length} modifier${detail.modifiers.length===1?'':'s'} retrieved).`;if(detail.warning)setMessage+=' '+detail.warning;}else{setMessage='Modifier set not found by exact or normalized name.'+(suggestionText.length?` Square modifier lists visible to this account include: ${suggestionText.join(' | ')}`:' No modifier lists were returned by Square.');}details.push({kind:'modifier_set',name:ms.squareName,status:setFound?'valid':'missing',message:setMessage,canonicalName:canonicalSetName,suggestions:suggestionText});for(const m of ms.modifiers||[]){totalCount++;const exactModifier=detail?.modifiers?.find(x=>x?.modifier_data?.name===m.squareName&&!x?.is_deleted)||null;const normalizedModifier=exactModifier?null:(detail?.modifiers?.find(x=>normalizeSquareCatalogName(x?.modifier_data?.name)===normalizeSquareCatalogName(m.squareName)&&!x?.is_deleted)||null);const match=exactModifier||normalizedModifier;let status=match?'valid':'missing';const actual=match?.modifier_data?.price_money?.amount;if(match&&m.expectedPriceCents!=null&&actual!=null&&Number(actual)!==Number(m.expectedPriceCents))status='price_mismatch';if(status==='valid')validCount++;updates.push(env.DB.prepare(`UPDATE registration_square_modifiers SET square_modifier_id=?,validation_status=? WHERE id=? AND modifier_set_id=?`).bind(match?.id||null,status,m.id,ms.id));const modSuggestions=detail?.modifiers? squareNameSuggestions(detail.modifiers,m.squareName,x=>x?.modifier_data?.name,5).map(x=>x.name):[];const canonicalModName=match?.modifier_data?.name||'';let modMessage;if(status==='valid')modMessage=normalizedModifier?`Matched after punctuation/spacing normalization to Square modifier “${canonicalModName}”.`:'Modifier found in the configured modifier set.';else if(status==='price_mismatch')modMessage=`Modifier found as “${canonicalModName}”, but Square price is $${(Number(actual)/100).toFixed(2)} instead of $${(Number(m.expectedPriceCents)/100).toFixed(2)}.`;else if(setFound)modMessage='Modifier set was found, but this modifier name was not found inside it.'+(modSuggestions.length?` Closest modifiers: ${modSuggestions.join(' | ')}`:'');else modMessage='Modifier cannot be checked until its modifier set is found.';details.push({kind:'modifier',name:m.squareName,status,message:modMessage,canonicalName:canonicalModName,suggestions:modSuggestions});}}
        let overall=validCount===totalCount?'valid':validCount===0?'invalid':'partial';const message=overall==='valid'?`Validated ${validCount} of ${totalCount} Square mappings.`:`Validated ${validCount} of ${totalCount} Square mappings. Review the detailed results below.`;updates.push(env.DB.prepare(`UPDATE registration_square_settings SET validation_status=?,validation_message=?,last_validated_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE form_id=?`).bind(overall,message,id));await env.DB.batch(updates);await writeAudit(env,session.user_id,"registration_square_validated","form",id,{status:overall,validCount,totalCount,details});
        return json({ok:true,validationStatus:overall,message,details,form:await getFormBuilderBundle(env,id)},200,headers);
      }


      // Forms Builder v24 public renderer API ----------------------------------
      if(url.pathname==="/api/public/form" && request.method==="GET"){
        const slug=safeFormSlug(url.searchParams.get("slug")||"");if(!slug)return json({ok:false,error:"Form slug is required."},400,headers);
        const row=await env.DB.prepare(`SELECT * FROM forms WHERE slug=? LIMIT 1`).bind(slug).first();if(!row)return json({ok:false,error:"Form not found."},404,headers);
        if(row.status!=="open")return json({ok:false,error:row.status==="closed"?"This form has closed.":"This form is not currently available."},410,headers);
        const now=Date.now(),opens=row.opens_at?Date.parse(row.opens_at):NaN,closes=row.closes_at?Date.parse(row.closes_at):NaN;if(Number.isFinite(opens)&&now<opens)return json({ok:false,error:"This form has not opened yet."},403,headers);if(Number.isFinite(closes)&&now>closes)return json({ok:false,error:"This form has closed."},410,headers);
        const bundle=await getFormBuilderBundle(env,row.id);if(!bundle)return json({ok:false,error:"Form not found."},404,headers);
        if(bundle.formType==='registration'){
          bundle.square={allowCheck:Boolean(bundle.square?.allowCheck),checkInstructions:bundle.square?.checkInstructions||'',variations:(bundle.square?.variations||[]).map(v=>({id:v.id,internalLabel:v.internalLabel,expectedPriceCents:v.expectedPriceCents,pricingPhase:v.pricingPhase,triggerQuestionKey:v.triggerQuestionKey,triggerValue:v.triggerValue,activeFrom:v.activeFrom,activeUntil:v.activeUntil})),modifierSets:(bundle.square?.modifierSets||[]).map(ms=>({id:ms.id,internalPurpose:ms.internalPurpose,modifiers:(ms.modifiers||[]).map(m=>({id:m.id,internalLabel:m.internalLabel,expectedPriceCents:m.expectedPriceCents,triggerQuestionKey:m.triggerQuestionKey,triggerValue:m.triggerValue,activeFrom:m.activeFrom,activeUntil:m.activeUntil}))}))};
        } else delete bundle.square;
        bundle.submissionEnabled=true;return json({ok:true,form:bundle},200,headers);
      }
      if(url.pathname==="/api/public/form-response" && request.method==="POST"){
        const body=await safeJson(request);if(!body)return json({ok:false,error:"Invalid JSON body."},400,headers);if(String(body.website||"").trim())return json({ok:true},200,headers);
        const slug=safeFormSlug(body.formSlug||"");const row=await env.DB.prepare(`SELECT * FROM forms WHERE slug=? LIMIT 1`).bind(slug).first();if(!row)return json({ok:false,error:"Form not found."},404,headers);if(row.form_type!=="survey")return json({ok:false,error:"Online registration submission will be enabled in the registration phase."},409,headers);if(row.status!=="open")return json({ok:false,error:"This form is not currently accepting responses."},410,headers);
        const now=Date.now(),opens=row.opens_at?Date.parse(row.opens_at):NaN,closes=row.closes_at?Date.parse(row.closes_at):NaN;if(Number.isFinite(opens)&&now<opens)return json({ok:false,error:"This form has not opened yet."},403,headers);if(Number.isFinite(closes)&&now>closes)return json({ok:false,error:"This form has closed."},410,headers);
        const qr=await env.DB.prepare(`SELECT * FROM form_questions WHERE form_id=? ORDER BY display_order,id`).bind(row.id).all(),questions=qr.results||[],incoming=body.answers&&typeof body.answers==="object"?body.answers:{};const cleaned={};let respondentEmail='';
        for(const q of questions){if(['section','info'].includes(q.question_type))continue;const cond=parseConditionalJson(q.conditional_json);if(!formConditionMatches(cond,cleaned))continue;let v=incoming[q.question_key];if(['checkbox','multi_select'].includes(q.question_type)){v=Array.isArray(v)?v.map(x=>String(x||'').trim()).filter(Boolean).slice(0,100):[];if(q.required&&!v.length)return json({ok:false,error:`Please answer: ${q.label}`},400,headers);}else{v=String(v??'').trim().slice(0,5000);if(q.required&&!v)return json({ok:false,error:`Please answer: ${q.label}`},400,headers);}if(q.question_type==='email'&&typeof v==='string'&&v){if(!isEmail(v))return json({ok:false,error:`Enter a valid email for: ${q.label}`},400,headers);if(!respondentEmail)respondentEmail=normalizeEmail(v);}cleaned[q.question_key]=v;}
        if(!row.allow_multiple&&respondentEmail){const prior=await env.DB.prepare(`SELECT id FROM form_responses WHERE form_id=? AND lower(respondent_email)=lower(?) LIMIT 1`).bind(row.id,respondentEmail).first();if(prior)return json({ok:false,error:"A response from this email has already been recorded."},409,headers);}
        const rid=crypto.randomUUID(),stmts=[env.DB.prepare(`INSERT INTO form_responses (id,form_id,respondent_email,submitted_at) VALUES (?,?,?,CURRENT_TIMESTAMP)`).bind(rid,row.id,respondentEmail||null)];for(const q of questions){if(['section','info'].includes(q.question_type)||!(q.question_key in cleaned))continue;const v=cleaned[q.question_key];if(Array.isArray(v)){for(const one of v)stmts.push(env.DB.prepare(`INSERT INTO form_answers (id,response_id,question_id,answer_text) VALUES (?,?,?,?)`).bind(crypto.randomUUID(),rid,q.id,one));}else stmts.push(env.DB.prepare(`INSERT INTO form_answers (id,response_id,question_id,answer_text) VALUES (?,?,?,?)`).bind(crypto.randomUUID(),rid,q.id,v));}await env.DB.batch(stmts);return json({ok:true,responseId:rid},201,headers);
      }


      // Forms Builder v25 registration checkout + verification ----------------
      if(url.pathname==="/api/public/registration-checkout" && request.method==="POST"){
        const body=await safeJson(request);if(!body)return json({ok:false,error:"Invalid JSON body."},400,headers);if(String(body.website||"").trim())return json({ok:true},200,headers);
        const slug=safeFormSlug(body.formSlug||"");const row=await env.DB.prepare(`SELECT * FROM forms WHERE slug=? LIMIT 1`).bind(slug).first();if(!row)return json({ok:false,error:"Registration form not found."},404,headers);if(row.form_type!=="registration")return json({ok:false,error:"This form is not a registration."},400,headers);if(row.status!=="open")return json({ok:false,error:"This registration is not currently open."},410,headers);
        const now=Date.now(),opens=row.opens_at?Date.parse(row.opens_at):NaN,closes=row.closes_at?Date.parse(row.closes_at):NaN;if(Number.isFinite(opens)&&now<opens)return json({ok:false,error:"Registration has not opened yet."},403,headers);if(Number.isFinite(closes)&&now>closes)return json({ok:false,error:"Registration has closed."},410,headers);
        const bundle=await getFormBuilderBundle(env,row.id);if(!bundle||bundle.square?.validationStatus!=="valid")return json({ok:false,error:"Registration payment configuration is not ready."},503,headers);
        const incoming=body.answers&&typeof body.answers==='object'?body.answers:{};const cleaned={};let respondentEmail='';
        for(const q of bundle.questions||[]){if(['section','info'].includes(q.type))continue;const visible=formConditionMatches(q.conditional,cleaned);if(!visible)continue;let v=incoming[q.key];if(['checkbox','multi_select'].includes(q.type)){v=Array.isArray(v)?v.map(x=>String(x||'').trim()).filter(Boolean).slice(0,100):[];if(q.required&&!v.length)return json({ok:false,error:`Please answer: ${q.label}`},400,headers);}else{v=String(v??'').trim().slice(0,5000);if(q.required&&!v)return json({ok:false,error:`Please answer: ${q.label}`},400,headers);}if(q.type==='email'&&typeof v==='string'&&v){if(!isEmail(v))return json({ok:false,error:`Enter a valid email for: ${q.label}`},400,headers);if(!respondentEmail)respondentEmail=normalizeEmail(v);}cleaned[q.key]=v;}
        if(!row.allow_multiple&&respondentEmail){const prior=await env.DB.prepare(`SELECT id FROM form_responses WHERE form_id=? AND lower(respondent_email)=lower(?) LIMIT 1`).bind(row.id,respondentEmail).first();if(prior)return json({ok:false,error:"A registration from this email has already been recorded."},409,headers);}
        const paymentMethod=String(body.paymentMethod||'square')==='check'&&bundle.square.allowCheck?'check':'square';
        const variationDiagnostics=(bundle.square.variations||[]).map(v=>diagnoseSquareRule(v,cleaned,now));
        const activeVariation=(bundle.square.variations||[]).filter(v=>squareRuleMatches(v,cleaned,now));
        if(activeVariation.length!==1){
          const summary=variationDiagnostics.map(d=>`${d.label||'Unnamed variation'}: ${d.reason}`).join(' | ');
          return json({ok:false,error:activeVariation.length?`Registration configuration matched more than one price rule. ${summary}`:`No registration price matched your selections. ${summary}`,diagnostics:variationDiagnostics,submittedAnswers:cleaned},409,headers);
        }
        const variation=activeVariation[0];
        // Check/manual registrations use the same configured pricing rules but do not depend on
        // Square catalog IDs. Square IDs are required only when a hosted Square checkout is requested.
        if(paymentMethod==='square'&&!variation.squareVariationId)return json({ok:false,error:"The selected Square variation is not mapped."},503,headers);
        const modifiers=[];for(const ms of bundle.square.modifierSets||[]){for(const m of ms.modifiers||[]){if(squareRuleMatches(m,cleaned,now)){if(paymentMethod==='square'&&!m.squareModifierId)return json({ok:false,error:`Square modifier is not mapped: ${m.internalLabel||m.squareName}`},503,headers);modifiers.push({...m,_modifierSetName:ms.squareName});}}}
        let amount=await resolveBuilderCatalogAmount(env,bundle.square,variation,modifiers);
        if(amount==null){amount=Math.max(0,Number(variation.expectedPriceCents||0)+modifiers.reduce((a,m)=>a+Math.max(0,Number(m.expectedPriceCents||0)),0));}
        const rid=crypto.randomUUID();const stmts=[env.DB.prepare(`INSERT INTO form_responses (id,form_id,respondent_email,submitted_at) VALUES (?,?,?,CURRENT_TIMESTAMP)`).bind(rid,row.id,respondentEmail||null)];for(const q of bundle.questions||[]){if(['section','info'].includes(q.type)||!(q.key in cleaned))continue;const v=cleaned[q.key];if(Array.isArray(v)){for(const one of v)stmts.push(env.DB.prepare(`INSERT INTO form_answers (id,response_id,question_id,answer_text) VALUES (?,?,?,?)`).bind(crypto.randomUUID(),rid,q.id,one));}else stmts.push(env.DB.prepare(`INSERT INTO form_answers (id,response_id,question_id,answer_text) VALUES (?,?,?,?)`).bind(crypto.randomUUID(),rid,q.id,v));}
        stmts.push(env.DB.prepare(`INSERT INTO form_registration_payments (response_id,form_id,payment_method,payment_status,amount_due_cents,selected_variation_id,selected_modifiers_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`).bind(rid,row.id,paymentMethod,paymentMethod==='check'?'check_pending':'pending',amount,variation.id,JSON.stringify(modifiers.map(m=>m.id))));await env.DB.batch(stmts);
        if(paymentMethod==='check')return json({ok:true,responseId:rid,paymentStatus:'check_pending',amountDueCents:amount,checkInstructions:bundle.square.checkInstructions||''},201,headers);
        if(!env.SQUARE_ACCESS_TOKEN||!env.SQUARE_LOCATION_ID)return json({ok:false,error:`Registration ${rid} was saved, but Square checkout is unavailable. Contact the chapter.`},503,headers);
        const lineModifiers=modifiers.map(m=>({catalog_object_id:m.squareModifierId,quantity:'1'}));const lineItem={quantity:'1',catalog_object_id:variation.squareVariationId,...(lineModifiers.length?{modifiers:lineModifiers}:{})};const redirect=`https://www.tczk.org/forms/?form=${encodeURIComponent(slug)}&registration=${encodeURIComponent(rid)}`;
        const checkoutRes=await fetch(`${squareApiBase(env)}/v2/online-checkout/payment-links`,{method:'POST',headers:{'Authorization':`Bearer ${env.SQUARE_ACCESS_TOKEN}`,'Content-Type':'application/json','Square-Version':'2026-09-16'},body:JSON.stringify({idempotency_key:crypto.randomUUID(),order:{location_id:env.SQUARE_LOCATION_ID,line_items:[lineItem]},checkout_options:{allow_tipping:false,ask_for_shipping_address:false,enable_coupon:false,redirect_url:redirect},description:`${bundle.title} - ${rid}`,payment_note:`TCZK registration ${rid}`})});const checkoutData=await checkoutRes.json().catch(()=>null);if(!checkoutRes.ok){console.error('Generic registration checkout failed',checkoutRes.status,checkoutData);return json({ok:false,error:`Square could not create checkout. Registration ${rid} remains pending.`},502,headers);}const checkoutUrl=checkoutData?.payment_link?.url||checkoutData?.payment_link?.long_url,orderId=checkoutData?.payment_link?.order_id||null,linkId=checkoutData?.payment_link?.id||null;if(!checkoutUrl)return json({ok:false,error:`Square returned no checkout URL. Registration ${rid} remains pending.`},502,headers);
        let squareAmount=amount;
        if(orderId){
          try{
            const orderRes=await fetch(`${squareApiBase(env)}/v2/orders/${encodeURIComponent(orderId)}`,{headers:{'Authorization':`Bearer ${env.SQUARE_ACCESS_TOKEN}`,'Square-Version':'2026-09-16'}});
            const orderData=await orderRes.json().catch(()=>null);
            if(orderRes.ok){const actual=Number(orderData?.order?.total_money?.amount);if(Number.isFinite(actual)&&actual>=0)squareAmount=actual;}
          }catch(err){console.warn('Could not read Square order total for registration',rid,err?.message||err);}
        }
        await env.DB.prepare(`UPDATE form_registration_payments SET square_order_id=?,square_payment_link_id=?,square_checkout_url=?,amount_due_cents=?,updated_at=CURRENT_TIMESTAMP WHERE response_id=?`).bind(orderId,linkId,checkoutUrl,squareAmount,rid).run();return json({ok:true,responseId:rid,checkoutUrl,amountDueCents:squareAmount,paymentStatus:'pending'},201,headers);
      }
      if(url.pathname==="/api/public/registration-status" && request.method==="POST"){
        const body=await safeJson(request);const id=String(body?.responseId||'').trim();if(!id)return json({ok:false,error:'Registration number is required.'},400,headers);let p=await env.DB.prepare(`SELECT p.*,f.slug,f.title FROM form_registration_payments p JOIN forms f ON f.id=p.form_id WHERE p.response_id=? LIMIT 1`).bind(id).first();if(!p)return json({ok:false,error:'Registration not found.'},404,headers);if(body?.refreshSquare===true&&p.payment_method==='square'&&p.square_order_id&&env.SQUARE_ACCESS_TOKEN)p=await refreshBuilderSquareStatus(env,p);return json({ok:true,registration:{responseId:id,title:p.title,paymentMethod:p.payment_method,paymentStatus:p.payment_status,amountDueCents:Number(p.amount_due_cents||0),paidAt:p.paid_at||null}},200,headers);
      }
      if(url.pathname==="/api/admin/form-responses" && request.method==="GET"){
        const admin=await requireAdmin(request,env);if(!admin)return json({ok:false,error:'Administrator access required.'},403,headers);const type=String(url.searchParams.get('type')||'survey').toLowerCase()==='registration'?'registration':'survey';const formId=String(url.searchParams.get('formId')||'').trim();const fr=await env.DB.prepare(`SELECT id,title,slug,status,form_type FROM forms WHERE form_type=? ORDER BY updated_at DESC`).bind(type).all();const selected=formId||fr.results?.[0]?.id||'';if(!selected)return json({ok:true,forms:fr.results||[],responses:[]},200,headers);const q=(await env.DB.prepare(`SELECT id,question_key,label,question_type,display_order FROM form_questions WHERE form_id=? ORDER BY display_order,id`).bind(selected).all()).results||[];const rr=(await env.DB.prepare(`SELECT r.*,p.payment_method,p.payment_status,p.amount_due_cents,p.square_order_id,p.paid_at FROM form_responses r LEFT JOIN form_registration_payments p ON p.response_id=r.id WHERE r.form_id=? ORDER BY r.submitted_at DESC`).bind(selected).all()).results||[];const responses=[];for(const r of rr){const ar=(await env.DB.prepare(`SELECT q.question_key,a.answer_text FROM form_answers a JOIN form_questions q ON q.id=a.question_id WHERE a.response_id=? ORDER BY q.display_order,a.id`).bind(r.id).all()).results||[];const answers={};for(const a of ar){if(answers[a.question_key]===undefined)answers[a.question_key]=a.answer_text;else if(Array.isArray(answers[a.question_key]))answers[a.question_key].push(a.answer_text);else answers[a.question_key]=[answers[a.question_key],a.answer_text];}responses.push({id:r.id,email:r.respondent_email||'',submittedAt:r.submitted_at,paymentMethod:r.payment_method||'',paymentStatus:r.payment_status||'',amountDueCents:r.amount_due_cents==null?null:Number(r.amount_due_cents),paidAt:r.paid_at||null,answers});}return json({ok:true,forms:(fr.results||[]).map(x=>({id:x.id,title:x.title,slug:x.slug,status:x.status,formType:x.form_type})),selectedFormId:selected,questions:q.map(x=>({id:x.id,key:x.question_key,label:x.label,type:x.question_type})),responses},200,headers);
      }
      const formResponseAction=url.pathname.match(/^\/api\/admin\/form-responses\/([^/]+)\/(refresh-square|refresh-amount|mark-check-received)$/);if(formResponseAction&&request.method==='POST'){const admin=await requireAdmin(request,env);if(!admin)return json({ok:false,error:'Administrator access required.'},403,headers);const id=decodeURIComponent(formResponseAction[1]),action=formResponseAction[2];let p=await env.DB.prepare(`SELECT * FROM form_registration_payments WHERE response_id=? LIMIT 1`).bind(id).first();if(!p)return json({ok:false,error:'Registration payment not found.'},404,headers);if(action==='mark-check-received'){await env.DB.prepare(`UPDATE form_registration_payments SET payment_status='paid',paid_at=COALESCE(paid_at,CURRENT_TIMESTAMP),updated_at=CURRENT_TIMESTAMP WHERE response_id=?`).bind(id).run();}else if(action==='refresh-square'){p=await refreshBuilderSquareStatus(env,p);}else{p=await recalculateBuilderRegistrationAmount(env,p);}return json({ok:true,amountDueCents:p?.amount_due_cents==null?null:Number(p.amount_due_cents),paymentStatus:p?.payment_status||null},200,headers);}
      const deleteFormMatch=url.pathname.match(/^\/api\/admin\/forms\/([^/]+)\/delete$/);if(deleteFormMatch&&request.method==='POST'){const admin=await requirePrimaryAdmin(request,env);if(!admin)return json({ok:false,error:'Primary Administrator access required to permanently delete a form.'},403,headers);const id=decodeURIComponent(deleteFormMatch[1]),f=await env.DB.prepare(`SELECT * FROM forms WHERE id=? LIMIT 1`).bind(id).first();if(!f)return json({ok:false,error:'Form not found.'},404,headers);if(f.status!=='archived')return json({ok:false,error:'Only archived forms can be permanently deleted.'},409,headers);const c=await env.DB.prepare(`SELECT COUNT(*) AS c FROM form_responses WHERE form_id=?`).bind(id).first();await writeAudit(env,admin.user_id,'form_deleted','form',id,{title:f.title,slug:f.slug,formType:f.form_type,responseCount:Number(c?.c)||0});await env.DB.prepare(`DELETE FROM forms WHERE id=?`).bind(id).run();return json({ok:true,deleted:true},200,headers);}

      return json({ok:false,error:"Not found."},404,headers);
    } catch(error) {
      console.error(error);
      return json({ok:false,error:error?.message||"Unexpected worker error."},500,headers);
    }
  }
};



function familyTreeCleanSnapshot(c){
  return{
    name:c.name,
    sortLastName:c.sortLastName||"",
    rosterNumber:c.rosterNumber,
    memberType:c.memberType,
    familyCode:c.familyCode||null,
    bigUniqueId:c.bigUniqueId||null,
    foundingFather:Boolean(c.foundingFather),
    initiatedYear:c.initiatedYear,
    graduationYear:c.graduationYear,
    notes:c.notes||""
  };
}
function mapFamilyTreeChangeRequest(r){
  let proposed={},current=null;
  try{proposed=JSON.parse(r.proposed_json||"{}");}catch{}
  try{current=r.current_json?JSON.parse(r.current_json):null;}catch{}
  return{
    id:r.id,
    requestType:r.request_type,
    memberUniqueId:r.member_unique_id||null,
    proposed,current,
    requestNote:r.request_note||"",
    status:r.status,
    requestedBy:Number(r.requested_by)||null,
    requesterName:r.requester_name||"",
    requesterEmail:r.requester_email||"",
    reviewedBy:r.reviewed_by==null?null:Number(r.reviewed_by),
    reviewerName:r.reviewer_name||"",
    reviewerEmail:r.reviewer_email||"",
    reviewNote:r.review_note||"",
    createdAt:r.created_at,
    updatedAt:r.updated_at,
    reviewedAt:r.reviewed_at
  };
}
async function createFamilyTreeMemberRecord(env,clean){
  let prefix="";
  if(clean.memberType==="lineage"){
    const family=await env.DB.prepare(`SELECT code,id_prefix,active FROM family_tree_families WHERE code=? LIMIT 1`).bind(clean.familyCode).first();
    if(!family||!Number(family.active)) throw new Error("Choose an active lineage family.");
    prefix=String(family.id_prefix||family.code).trim().toUpperCase();
  }else if(clean.memberType==="lost_to_time") prefix="TMP";
  else prefix="H";

  const sequence=await env.DB.prepare(`SELECT last_number FROM family_tree_id_sequences WHERE prefix=? LIMIT 1`).bind(prefix).first();
  if(!sequence) throw new Error(`No ID sequence is configured for ${prefix}.`);

  const oldNumber=Number(sequence.last_number)||0;
  const nextNumber=oldNumber+1;
  const uniqueId=`${prefix}${String(nextNumber).padStart(3,"0")}`;

  const results=await env.DB.batch([
    env.DB.prepare(`
      INSERT INTO family_tree_members
        (unique_id,name,sort_last_name,roster_number,member_type,family_code,big_unique_id,
         founding_father,initiated_year,graduation_year,notes,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)
    `).bind(uniqueId,clean.name,clean.sortLastName,clean.rosterNumber,clean.memberType,
      clean.familyCode,clean.bigUniqueId,clean.foundingFather,clean.initiatedYear,clean.graduationYear,clean.notes),
    env.DB.prepare(`
      UPDATE family_tree_id_sequences SET last_number=?
      WHERE prefix=? AND last_number=?
    `).bind(nextNumber,prefix,oldNumber)
  ]);

  if(Number(results?.[1]?.meta?.changes||0)!==1)
    throw new Error("The ID sequence changed while this member was being created. Please try again.");

  return{uniqueId};
}
async function updateFamilyTreeMemberRecord(env,id,clean){
  await env.DB.prepare(`
    UPDATE family_tree_members
    SET name=?,sort_last_name=?,roster_number=?,member_type=?,family_code=?,big_unique_id=?,
        founding_father=?,initiated_year=?,graduation_year=?,notes=?,updated_at=CURRENT_TIMESTAMP
    WHERE unique_id=?
  `).bind(clean.name,clean.sortLastName,clean.rosterNumber,clean.memberType,clean.familyCode,
    clean.bigUniqueId,clean.foundingFather,clean.initiatedYear,clean.graduationYear,clean.notes,id).run();
}

function normalizeFamilyTreeId(v){
  const id=String(v||"").trim().toUpperCase();
  return /^[A-Z]{1,3}\d{3}$/.test(id)?id:"";
}
function normalizeFamilyTreeMemberType(v){
  v=String(v||"").trim().toLowerCase();
  return ["lineage","lost_to_time","honorary"].includes(v)?v:"";
}
function nullableInteger(v,min=0,max=9999){
  if(v===null||v===undefined||v==="")return null;
  const n=Number(v);
  return Number.isInteger(n)&&n>=min&&n<=max?n:NaN;
}
function mapFamilyTreeFamily(r){
  return{
    code:r.code,
    name:r.name,
    idPrefix:r.id_prefix,
    displayOrder:Number(r.display_order)||0,
    active:r.active===undefined?true:Boolean(r.active),
    memberCount:r.member_count===undefined?undefined:Number(r.member_count)||0
  };
}
function mapFamilyTreeMember(r){
  return{
    uniqueId:r.unique_id,
    name:r.name||"",
    sortLastName:r.sort_last_name||"",
    rosterNumber:r.roster_number==null?null:Number(r.roster_number),
    memberType:r.member_type,
    familyCode:r.family_code||null,
    familyName:r.family_name||null,
    bigUniqueId:r.big_unique_id||null,
    bigName:r.big_name||null,
    littleCount:r.little_count==null?undefined:Number(r.little_count)||0,
    foundingFather:Boolean(r.founding_father),
    initiatedYear:r.initiated_year==null?null:Number(r.initiated_year),
    graduationYear:r.graduation_year==null?null:Number(r.graduation_year),
    notes:r.notes||"",
    createdAt:r.created_at||null,
    updatedAt:r.updated_at||null
  };
}
function mapPublicFamilyTreeMember(r){
  return{
    uniqueId:r.unique_id,
    name:r.name||"",
    sortLastName:r.sort_last_name||"",
    rosterNumber:r.roster_number==null?null:Number(r.roster_number),
    memberType:r.member_type,
    familyCode:r.family_code||null,
    familyName:r.family_name||null,
    bigUniqueId:r.big_unique_id||null,
    bigName:r.big_name||null,
    foundingFather:Boolean(r.founding_father),
    initiatedYear:r.initiated_year==null?null:Number(r.initiated_year),
    graduationYear:r.graduation_year==null?null:Number(r.graduation_year)
  };
}
async function getFamilyTreeMember(env,id){
  return await env.DB.prepare(`
    SELECT m.*,f.name AS family_name,b.name AS big_name,
           (SELECT COUNT(*) FROM family_tree_members l
             WHERE l.big_unique_id=m.unique_id AND l.member_type='lineage') AS little_count
    FROM family_tree_members m
    LEFT JOIN family_tree_families f ON f.code=m.family_code
    LEFT JOIN family_tree_members b ON b.unique_id=m.big_unique_id
    WHERE m.unique_id=?
    LIMIT 1
  `).bind(id).first();
}
function familyTreeSnapshot(r){
  return{
    name:r?.name||"",
    sortLastName:r?.sort_last_name||"",
    rosterNumber:r?.roster_number==null?null:Number(r.roster_number),
    memberType:r?.member_type||"",
    familyCode:r?.family_code||null,
    bigUniqueId:r?.big_unique_id||null,
    foundingFather:Boolean(r?.founding_father),
    initiatedYear:r?.initiated_year==null?null:Number(r.initiated_year),
    graduationYear:r?.graduation_year==null?null:Number(r.graduation_year),
    notes:r?.notes||""
  };
}
async function cleanFamilyTreeMemberInput(env,body,current){
  const pick=(camel,snake,old)=>{
    if(Object.prototype.hasOwnProperty.call(body,camel))return body[camel];
    if(Object.prototype.hasOwnProperty.call(body,snake))return body[snake];
    return old;
  };

  const name=String(pick("name","name",current?.name)||"").trim().replace(/\s+/g," ").slice(0,180);
  if(name.length<2)return{error:"Member name is required."};

  const sortLastName=String(pick("sortLastName","sort_last_name",current?.sort_last_name)||"").trim().slice(0,120);

  const rosterNumber=nullableInteger(pick("rosterNumber","roster_number",current?.roster_number),1,99999);
  if(Number.isNaN(rosterNumber))return{error:"Roster number must be blank or a positive whole number."};

  const memberType=normalizeFamilyTreeMemberType(pick("memberType","member_type",current?.member_type||"lineage"));
  if(!memberType)return{error:"Member type must be lineage, lost_to_time, or honorary."};

  let familyCode=String(pick("familyCode","family_code",current?.family_code)||"").trim().toUpperCase()||null;
  let bigUniqueId=normalizeFamilyTreeId(pick("bigUniqueId","big_unique_id",current?.big_unique_id))||null;

  const foundingRaw=pick("foundingFather","founding_father",current?.founding_father||0);
  const foundingFather=foundingRaw===true||foundingRaw===1||String(foundingRaw)==="1"?1:0;

  const initiatedYear=nullableInteger(pick("initiatedYear","initiated_year",current?.initiated_year),1900,2100);
  if(Number.isNaN(initiatedYear))return{error:"Initiated year must be blank or a valid four-digit year."};

  const graduationYear=nullableInteger(pick("graduationYear","graduation_year",current?.graduation_year),1900,2100);
  if(Number.isNaN(graduationYear))return{error:"Graduation year must be blank or a valid four-digit year."};

  const notes=String(pick("notes","notes",current?.notes)||"").trim().slice(0,4000);

  if(memberType==="honorary"){
    // Honorary members do not participate in Big/Little lineage.
    familyCode=null;
    bigUniqueId=null;
  }

  if(memberType==="lineage"){
    if(!familyCode)return{error:"Lineage members must have a family."};
    const family=await env.DB.prepare(`SELECT code,active FROM family_tree_families WHERE code=? LIMIT 1`).bind(familyCode).first();
    if(!family)return{error:"Selected family does not exist."};
  }else if(familyCode){
    const family=await env.DB.prepare(`SELECT code FROM family_tree_families WHERE code=? LIMIT 1`).bind(familyCode).first();
    if(!family)return{error:"Selected family does not exist."};
  }

  if(bigUniqueId){
    const big=await env.DB.prepare(`SELECT unique_id,member_type,family_code FROM family_tree_members WHERE unique_id=? LIMIT 1`).bind(bigUniqueId).first();
    if(!big)return{error:"Selected Big Brother does not exist."};
    if(current?.unique_id&&bigUniqueId===current.unique_id)return{error:"A member cannot be his own Big Brother."};
    if(memberType==="lineage"&&big.member_type==="honorary")return{error:"An Honorary member cannot be assigned as a lineage Big Brother."};
    // Historical data can contain exceptions, so family mismatch is not hard-blocked here.
  }

  return{name,sortLastName,rosterNumber,memberType,familyCode,bigUniqueId,foundingFather,initiatedYear,graduationYear,notes};
}

function squareApiBase(env){
  return String(env.SQUARE_ENVIRONMENT||"production").toLowerCase()==="sandbox"
    ? "https://connect.squareupsandbox.com"
    : "https://connect.squareup.com";
}

async function findSquareVariation(env,itemName,variationName){
  const base=squareApiBase(env);
  const response=await fetch(`${base}/v2/catalog/search`,{
    method:"POST",
    headers:{
      "Authorization":`Bearer ${env.SQUARE_ACCESS_TOKEN}`,
      "Content-Type":"application/json",
      "Square-Version":"2026-08-19"
    },
    body:JSON.stringify({
      object_types:["ITEM"],
      query:{exact_query:{attribute_name:"name",attribute_value:itemName}},
      limit:100
    })
  });
  const data=await response.json().catch(()=>null);
  if(!response.ok){
    console.error("Square catalog lookup failed",response.status,data);
    throw new Error("Square catalog lookup failed.");
  }
  const item=(data?.objects||[]).find(o=>o?.type==="ITEM"&&o?.item_data?.name===itemName);
  if(!item)return null;
  const variations=Array.isArray(item.item_data?.variations)?item.item_data.variations:[];
  const variation=variations.find(v=>v?.type==="ITEM_VARIATION"&&v?.item_variation_data?.name===variationName&&!v?.is_deleted);
  if(!variation)return null;

  // Reject variations that Square explicitly says are unavailable at the configured location.
  if(Array.isArray(variation.absent_at_location_ids)&&variation.absent_at_location_ids.includes(env.SQUARE_LOCATION_ID))return null;
  if(variation.present_at_all_locations===false&&Array.isArray(variation.present_at_location_ids)&&!variation.present_at_location_ids.includes(env.SQUARE_LOCATION_ID))return null;
  return variation;
}

async function findSquareModifier(env,modifierListName,modifierName){
  const base=squareApiBase(env);
  let cursor=null;
  do{
    const qs=new URLSearchParams({types:"MODIFIER_LIST"});
    if(cursor)qs.set("cursor",cursor);
    const response=await fetch(`${base}/v2/catalog/list?${qs.toString()}`,{
      headers:{
        "Authorization":`Bearer ${env.SQUARE_ACCESS_TOKEN}`,
        "Square-Version":"2026-09-16"
      }
    });
    const data=await response.json().catch(()=>null);
    if(!response.ok){
      console.error("Square modifier catalog lookup failed",response.status,data);
      throw new Error("Square modifier catalog lookup failed.");
    }
    for(const list of data?.objects||[]){
      if(list?.type!=="MODIFIER_LIST"||list?.modifier_list_data?.name!==modifierListName)continue;
      const modifiers=Array.isArray(list.modifier_list_data?.modifiers)?list.modifier_list_data.modifiers:[];
      const modifier=modifiers.find(m=>m?.type==="MODIFIER"&&m?.modifier_data?.name===modifierName&&!m?.is_deleted);
      if(!modifier)return null;
      if(Array.isArray(modifier.absent_at_location_ids)&&modifier.absent_at_location_ids.includes(env.SQUARE_LOCATION_ID))return null;
      if(modifier.present_at_all_locations===false&&Array.isArray(modifier.present_at_location_ids)&&!modifier.present_at_location_ids.includes(env.SQUARE_LOCATION_ID))return null;
      return modifier;
    }
    cursor=data?.cursor||null;
  }while(cursor);
  return null;
}



// Legacy Formal helper functions retired in v29.3.
const FORM_QUESTION_TYPES=new Set(['text','email','phone','number','date','textarea','select','radio','checkbox','multi_select','yes_no','section','info']);
function safeFormSlug(v){return String(v||'').toLowerCase().trim().replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'').slice(0,80);}
function safeQuestionKey(v){return String(v||'').toLowerCase().trim().replace(/[^a-z0-9_]+/g,'_').replace(/^_+|_+$/g,'').slice(0,80);}
function cleanNullableDate(v){const s=String(v||'').trim();return s?s.slice(0,40):null;}
function toNullableCents(v){if(v===null||v===undefined||v==='')return null;const n=Number(v);return Number.isFinite(n)&&n>=0?Math.round(n):null;}
function mapFormListRow(r){return{id:r.id,slug:r.slug,formType:r.form_type,title:r.title,description:r.description||'',status:r.status,opensAt:r.opens_at||null,closesAt:r.closes_at||null,eventDate:r.event_date||null,publicPath:r.public_path||'',allowMultiple:Boolean(r.allow_multiple),questionCount:Number(r.question_count)||0,responseCount:Number(r.response_count)||0,createdAt:r.created_at,updatedAt:r.updated_at};}
function parseJsonArray(v){try{const a=JSON.parse(v||'null');return Array.isArray(a)?a:[]}catch{return[]}}
async function getFormBuilderBundle(env,id){
  const f=await env.DB.prepare(`SELECT * FROM forms WHERE id=? LIMIT 1`).bind(id).first();if(!f)return null;
  const qr=await env.DB.prepare(`SELECT * FROM form_questions WHERE form_id=? ORDER BY display_order,id`).bind(id).all();
  const rc=await env.DB.prepare(`SELECT COUNT(*) AS c FROM form_responses WHERE form_id=?`).bind(id).first();const out={id:f.id,slug:f.slug,formType:f.form_type,title:f.title,description:f.description||'',status:f.status,opensAt:f.opens_at||null,closesAt:f.closes_at||null,eventDate:f.event_date||null,publicPath:f.public_path||'',allowMultiple:Boolean(f.allow_multiple),responseCount:Number(rc?.c)||0,createdAt:f.created_at,updatedAt:f.updated_at,questions:(qr.results||[]).map(q=>({id:q.id,key:q.question_key,label:q.label,helpText:q.help_text||'',type:q.question_type,options:parseJsonArray(q.options_json).map(String),required:Boolean(q.required),conditional:parseConditionalJson(q.conditional_json),order:Number(q.display_order)||0}))};
  if(f.form_type==='registration'){
    const settings=await env.DB.prepare(`SELECT * FROM registration_square_settings WHERE form_id=? LIMIT 1`).bind(id).first();const vr=await env.DB.prepare(`SELECT * FROM registration_square_variations WHERE form_id=? ORDER BY display_order,id`).bind(id).all();const sr=await env.DB.prepare(`SELECT * FROM registration_square_modifier_sets WHERE form_id=? ORDER BY display_order,id`).bind(id).all();const sets=[];
    for(const s of sr.results||[]){const mr=await env.DB.prepare(`SELECT * FROM registration_square_modifiers WHERE modifier_set_id=? ORDER BY display_order,id`).bind(s.id).all();sets.push({id:s.id,internalPurpose:s.internal_purpose||'',squareName:s.square_name||'',squareModifierSetId:s.square_modifier_set_id||null,validationStatus:s.validation_status||'not_validated',order:Number(s.display_order)||0,modifiers:(mr.results||[]).map(m=>({id:m.id,internalLabel:m.internal_label||'',squareName:m.square_name||'',squareModifierId:m.square_modifier_id||null,expectedPriceCents:m.expected_price_cents==null?null:Number(m.expected_price_cents),triggerQuestionKey:m.trigger_question_key||'',triggerValue:m.trigger_value||'',activeFrom:m.active_from||null,activeUntil:m.active_until||null,validationStatus:m.validation_status||'not_validated',order:Number(m.display_order)||0}))});}
    out.square={itemName:settings?.item_name||'',itemId:settings?.item_id||null,validationStatus:settings?.validation_status||'not_validated',validationMessage:settings?.validation_message||'',lastValidatedAt:settings?.last_validated_at||null,allowCheck:Boolean(settings?.allow_check),checkInstructions:settings?.check_instructions||'',variations:(vr.results||[]).map(v=>({id:v.id,internalLabel:v.internal_label||'',squareName:v.square_name||'',squareVariationId:v.square_variation_id||null,expectedPriceCents:v.expected_price_cents==null?null:Number(v.expected_price_cents),pricingPhase:v.pricing_phase||'standard',triggerQuestionKey:v.trigger_question_key||'',triggerValue:v.trigger_value||'',activeFrom:v.active_from||null,activeUntil:v.active_until||null,validationStatus:v.validation_status||'not_validated',order:Number(v.display_order)||0})),modifierSets:sets};
  }
  return out;
}

function parseConditionalJson(v){try{const o=JSON.parse(v||'null');return o&&typeof o==='object'?o:null}catch{return null}}
function normalizeRuleValue(value){return String(value??'').trim().toLocaleLowerCase();}
function answerHas(answer,value){const wanted=normalizeRuleValue(value);if(Array.isArray(answer))return answer.some(v=>normalizeRuleValue(v)===wanted);return normalizeRuleValue(answer)===wanted;}
function conditionHasAnswer(a){return Array.isArray(a)?a.length>0:String(a??'').trim()!=='';}function formConditionMatches(cond,answers){if(!cond||!cond.questionKey)return true;const a=answers?.[cond.questionKey],op=cond.operator||'equals',v=cond.value??'';if(op==='answered')return conditionHasAnswer(a);if(op==='not_answered')return !conditionHasAnswer(a);if(op==='not_equals')return conditionHasAnswer(a)&&!answerHas(a,v);if(op==='includes'){if(!conditionHasAnswer(a))return false;return Array.isArray(a)?answerHas(a,v):normalizeRuleValue(a).includes(normalizeRuleValue(v));}if(op==='not_includes'){if(!conditionHasAnswer(a))return false;return Array.isArray(a)?!answerHas(a,v):!normalizeRuleValue(a).includes(normalizeRuleValue(v));}return answerHas(a,v);}
function withinWindow(rule,now=Date.now()){const a=rule?.activeFrom?Date.parse(rule.activeFrom):NaN,b=rule?.activeUntil?Date.parse(rule.activeUntil):NaN;return !(Number.isFinite(a)&&now<a)&&!(Number.isFinite(b)&&now>b);}
function squareRuleMatches(rule,answers,now=Date.now()){if(!withinWindow(rule,now))return false;const key=String(rule?.triggerQuestionKey||'').trim();if(!key)return true;return answerHas(answers?.[key],rule?.triggerValue??'');}
function diagnoseSquareRule(rule,answers,now=Date.now()){
  const label=String(rule?.internalLabel||rule?.squareName||'').trim();
  const key=String(rule?.triggerQuestionKey||'').trim();
  const expected=String(rule?.triggerValue??'');
  const actual=key ? answers?.[key] : undefined;
  const activeFrom=rule?.activeFrom||null,activeUntil=rule?.activeUntil||null;
  if(!withinWindow(rule,now)) return {label,key,expected,actual,activeFrom,activeUntil,matched:false,reason:`pricing window inactive (from ${activeFrom||'no start'} until ${activeUntil||'no end'})`};
  if(!key) return {label,key,expected,actual,activeFrom,activeUntil,matched:true,reason:'no trigger question; rule matches by date'};
  if(!(key in (answers||{}))) return {label,key,expected,actual:null,activeFrom,activeUntil,matched:false,reason:`trigger question key '${key}' was not submitted`};
  if(!answerHas(actual,expected)) return {label,key,expected,actual,activeFrom,activeUntil,matched:false,reason:`expected '${expected}' but received '${Array.isArray(actual)?actual.join(', '):String(actual??'')}' for '${key}'`};
  return {label,key,expected,actual,activeFrom,activeUntil,matched:true,reason:'matched'};
}

async function retrieveSquareCatalogObject(env,objectId){
  if(!objectId||!env.SQUARE_ACCESS_TOKEN)return null;
  const base=squareApiBase(env);
  const response=await fetch(`${base}/v2/catalog/object/${encodeURIComponent(objectId)}?include_related_objects=true`,{headers:{'Authorization':`Bearer ${env.SQUARE_ACCESS_TOKEN}`,'Square-Version':'2026-09-16'}});
  const data=await response.json().catch(()=>null);
  if(!response.ok){console.warn('Square catalog object lookup failed',objectId,response.status,data);return null;}
  return data?.object||null;
}
async function resolveBuilderCatalogAmount(env,square,variation,modifiers){
  if(!env.SQUARE_ACCESS_TOKEN||!variation?.squareVariationId)return null;
  try{
    const v=await retrieveSquareCatalogObject(env,variation.squareVariationId);
    const base=Number(v?.item_variation_data?.price_money?.amount);
    if(!Number.isFinite(base)||base<0)return null;
    let total=base;
    for(const m of modifiers||[]){
      if(!m?.squareModifierId)continue;
      const obj=await retrieveSquareCatalogObject(env,m.squareModifierId);
      const price=Number(obj?.modifier_data?.price_money?.amount??0);
      if(Number.isFinite(price)&&price>0)total+=price;
    }
    return Math.max(0,total);
  }catch(err){console.warn('Could not resolve Square catalog amount',err?.message||err);return null;}
}
async function recalculateBuilderRegistrationAmount(env,p){
  const bundle=await getFormBuilderBundle(env,p.form_id);if(!bundle?.square)return p;
  const variation=(bundle.square.variations||[]).find(v=>v.id===p.selected_variation_id);if(!variation)return p;
  let ids=[];try{ids=JSON.parse(p.selected_modifiers_json||'[]');if(!Array.isArray(ids))ids=[];}catch{}
  const modifiers=[];for(const ms of bundle.square.modifierSets||[]){for(const m of ms.modifiers||[]){if(ids.includes(m.id))modifiers.push(m);}}
  const amount=await resolveBuilderCatalogAmount(env,bundle.square,variation,modifiers);if(amount==null)return p;
  await env.DB.prepare(`UPDATE form_registration_payments SET amount_due_cents=?,updated_at=CURRENT_TIMESTAMP WHERE response_id=?`).bind(amount,p.response_id).run();
  return await env.DB.prepare(`SELECT * FROM form_registration_payments WHERE response_id=?`).bind(p.response_id).first();
}
async function refreshBuilderSquareStatus(env,p){
  if(!p?.square_order_id||!env.SQUARE_ACCESS_TOKEN)return p;
  const base=squareApiBase(env);
  // The stored Square order is the authoritative source for what checkout actually totaled.
  try{
    const orderRes=await fetch(`${base}/v2/orders/${encodeURIComponent(p.square_order_id)}`,{headers:{'Authorization':`Bearer ${env.SQUARE_ACCESS_TOKEN}`,'Square-Version':'2026-09-16'}});
    const orderData=await orderRes.json().catch(()=>null);
    if(orderRes.ok){
      const actual=Number(orderData?.order?.total_money?.amount);
      if(Number.isFinite(actual)&&actual>=0){
        await env.DB.prepare(`UPDATE form_registration_payments SET amount_due_cents=?,updated_at=CURRENT_TIMESTAMP WHERE response_id=?`).bind(actual,p.response_id).run();
        p=await env.DB.prepare(`SELECT * FROM form_registration_payments WHERE response_id=?`).bind(p.response_id).first();
      }
    }else console.warn('Square order refresh failed',p.square_order_id,orderRes.status,orderData);
  }catch(err){console.warn('Square order refresh failed',p.square_order_id,err?.message||err);}
  let begin;try{const created=Date.parse(p.created_at);if(Number.isFinite(created))begin=new Date(Math.max(0,created-3600000)).toISOString();}catch{}
  let cursor=null;
  for(let page=0;page<5;page++){
    const params=new URLSearchParams({location_id:env.SQUARE_LOCATION_ID,limit:'100',sort_order:'DESC'});if(begin)params.set('begin_time',begin);if(cursor)params.set('cursor',cursor);
    const res=await fetch(`${base}/v2/payments?${params.toString()}`,{headers:{'Authorization':`Bearer ${env.SQUARE_ACCESS_TOKEN}`,'Square-Version':'2026-09-16'}});
    const data=await res.json().catch(()=>null);if(!res.ok)return p;
    const payment=(data?.payments||[]).find(x=>String(x?.order_id||'')===String(p.square_order_id)&&String(x?.status||'').toUpperCase()==='COMPLETED');
    if(payment){
      const paid=Number(payment?.total_money?.amount??payment?.amount_money?.amount);
      await env.DB.prepare(`UPDATE form_registration_payments SET payment_status='paid',amount_due_cents=CASE WHEN ? >= 0 THEN ? ELSE amount_due_cents END,paid_at=COALESCE(paid_at,CURRENT_TIMESTAMP),updated_at=CURRENT_TIMESTAMP WHERE response_id=?`).bind(Number.isFinite(paid)?paid:-1,Number.isFinite(paid)?paid:-1,p.response_id).run();
      return await env.DB.prepare(`SELECT * FROM form_registration_payments WHERE response_id=?`).bind(p.response_id).first();
    }
    cursor=data?.cursor||null;if(!cursor)break;
  }
  return await env.DB.prepare(`SELECT * FROM form_registration_payments WHERE response_id=?`).bind(p.response_id).first();
}

async function findSquareItemDetailed(env,itemName){
  const base=squareApiBase(env);const response=await fetch(`${base}/v2/catalog/search`,{method:'POST',headers:{'Authorization':`Bearer ${env.SQUARE_ACCESS_TOKEN}`,'Content-Type':'application/json','Square-Version':'2026-09-16'},body:JSON.stringify({object_types:['ITEM'],query:{exact_query:{attribute_name:'name',attribute_value:itemName}},limit:100})});const data=await response.json().catch(()=>null);if(!response.ok)throw new Error('Square catalog lookup failed.');const item=(data?.objects||[]).find(o=>o?.type==='ITEM'&&o?.item_data?.name===itemName&&!o?.is_deleted);if(!item)return null;return{id:item.id,variations:Array.isArray(item.item_data?.variations)?item.item_data.variations:[]};
}
async function listSquareCatalogType(env,type){
  const base=squareApiBase(env);let cursor=null;const objects=[];
  do{
    const qs=new URLSearchParams({types:type});if(cursor)qs.set('cursor',cursor);
    const response=await fetch(`${base}/v2/catalog/list?${qs.toString()}`,{headers:{'Authorization':`Bearer ${env.SQUARE_ACCESS_TOKEN}`,'Square-Version':'2026-09-16'}});
    const data=await response.json().catch(()=>null);
    if(!response.ok){const detail=data?.errors?.map(e=>e?.detail||e?.code).filter(Boolean).join('; ');const err=new Error(detail?`Square catalog lookup failed (${type}): ${detail}`:`Square catalog lookup failed (${type}) with HTTP ${response.status}.`);throw err;}
    for(const obj of data?.objects||[])if(!obj?.is_deleted)objects.push(obj);
    cursor=data?.cursor||null;
  }while(cursor);
  return objects;
}
function normalizeSquareCatalogName(value){
  return String(value||'')
    .normalize('NFKC')
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2212]/g,'-')
    .replace(/\s*-\s*/g,' - ')
    .replace(/\s+/g,' ')
    .trim()
    .toLowerCase();
}
function squareNameSuggestions(objects,requested,getName,limit=5){
  const target=normalizeSquareCatalogName(requested);
  const tokens=target.split(/[^a-z0-9]+/).filter(Boolean);
  return (objects||[]).map(obj=>{
    const name=getName(obj)||'';
    const norm=normalizeSquareCatalogName(name);
    let score=0;
    if(norm===target)score+=100;
    for(const t of tokens)if(norm.includes(t))score+=1;
    if(target&&norm.includes(target))score+=20;
    if(norm&&target.includes(norm))score+=10;
    return{name,obj,score};
  }).filter(x=>x.name).sort((a,b)=>b.score-a.score||a.name.localeCompare(b.name)).slice(0,limit);
}
async function findSquareModifierListDetailed(env,listName){
  const lists=await listSquareCatalogType(env,'MODIFIER_LIST');
  const exact=lists.find(obj=>obj?.type==='MODIFIER_LIST'&&obj?.modifier_list_data?.name===listName)||null;
  const normalizedTarget=normalizeSquareCatalogName(listName);
  const normalized=exact?null:(lists.find(obj=>obj?.type==='MODIFIER_LIST'&&normalizeSquareCatalogName(obj?.modifier_list_data?.name)===normalizedTarget)||null);
  const foundList=exact||normalized;
  const suggestions=squareNameSuggestions(lists,listName,obj=>obj?.modifier_list_data?.name,5);
  if(!foundList)return{list:null,modifiers:[],warning:'',matchType:'missing',suggestions};
  const embedded=Array.isArray(foundList.modifier_list_data?.modifiers)?foundList.modifier_list_data.modifiers:[];
  let linked=[];let modifierLookupWarning='';
  try{
    const modifiers=await listSquareCatalogType(env,'MODIFIER');
    linked=modifiers.filter(m=>m?.type==='MODIFIER'&&m?.modifier_data?.modifier_list_id===foundList.id);
  }catch(err){
    modifierLookupWarning=err?.message||'Standalone modifier lookup failed; using embedded modifiers.';
  }
  const byId=new Map();for(const m of [...embedded,...linked])if(m?.id)byId.set(m.id,m);
  return{list:foundList,modifiers:[...byId.values()],warning:modifierLookupWarning,matchType:exact?'exact':'normalized',suggestions};
}

function csvCell(v){v=Array.isArray(v)?v.join(" | "):String(v??"");return `"${v.replace(/"/g,'""')}"`;}
function surveyDetailedCsv(b){const heads=["Response ID","Submitted At",...b.questions.map(q=>q.label)];const rows=b.responses.map(r=>[r.id,r.submittedAt,...b.questions.map(q=>r.answers?.[q.key]??"")]);return '\uFEFF'+[heads,...rows].map(row=>row.map(csvCell).join(',')).join('\r\n');}
function surveySummaryCsv(b){const s=surveySummary(b.questions,b.responses),rows=[["Survey",b.survey.title],["Generated",new Date().toISOString()],["Total Responses",b.responses.length],[],["Question","Response","Count","Percent"]];for(const q of s){if(q.options.length)for(const o of q.options)rows.push([q.label,o.label,o.count,o.percent.toFixed(1)+"%"]);else rows.push([q.label,"Answered",q.answered,b.responses.length?(q.answered/b.responses.length*100).toFixed(1)+"%":"0.0%"]);}return '\uFEFF'+rows.map(row=>row.map(csvCell).join(',')).join('\r\n');}
function surveySummaryPdfLines(b){const lines=[b.survey.title,"Survey Summary",`Generated: ${new Date().toLocaleString('en-US')}`,`Total responses: ${b.responses.length}`,""];for(const q of surveySummary(b.questions,b.responses)){lines.push(q.label);if(q.options.length)q.options.forEach(o=>lines.push(`  ${o.label}: ${o.count} (${o.percent.toFixed(1)}%)`));else lines.push(`  Answered: ${q.answered}`);lines.push("");}return lines;}
function surveyDetailedPdfLines(b){const lines=[b.survey.title,"Detailed Responses",`Generated: ${new Date().toLocaleString('en-US')}`,`Total responses: ${b.responses.length}`,""];b.responses.forEach((r,i)=>{lines.push(`Response ${i+1} - ${r.respondentName||'Unnamed'} - ${r.submittedAt}`);for(const q of b.questions){const v=r.answers?.[q.key];lines.push(`${q.label}: ${Array.isArray(v)?v.join(' | '):(v||'—')}`);}lines.push("");});return lines;}
function fileResponse(body,filename,contentType,baseHeaders={}){const h=new Headers(baseHeaders);h.set('Content-Type',contentType);h.set('Content-Disposition',`attachment; filename="${filename.replace(/"/g,'')}"`);h.set('Cache-Control','no-store');return new Response(body,{status:200,headers:h});}

async function requireSession(request,env){
  const token=bearerToken(request);if(!token)return null;
  const tokenHash=await sha256Hex(token);
  const row=await env.DB.prepare(`SELECT s.id AS session_id,s.user_id,s.expires_at,u.email,u.display_name,u.role,u.priority,u.active FROM admin_sessions s JOIN admin_users u ON u.id=s.user_id WHERE s.token_hash=? LIMIT 1`).bind(tokenHash).first();
  if(!row||!row.active)return null;
  const expires=Date.parse(row.expires_at);
  if(!Number.isFinite(expires)||expires<=Date.now()){await env.DB.prepare("DELETE FROM admin_sessions WHERE id=?").bind(row.session_id).run();return null;}
  await env.DB.prepare(`UPDATE admin_sessions SET last_used_at=CURRENT_TIMESTAMP WHERE id=?`).bind(row.session_id).run();
  return row;
}
function historySafeFilename(name){
  const cleaned=String(name||"file").replace(/[^\w.\- ()]+/g,"_").replace(/\s+/g," ").trim().slice(0,180);
  return cleaned||"file";
}
function historyDownloadFilename(name){return historySafeFilename(name).replace(/"/g,"_");}
function historyFormatBytes(n){n=Number(n)||0;if(n<1024)return`${n} B`;if(n<1048576)return`${(n/1024).toFixed(1)} KB`;return`${(n/1048576).toFixed(1)} MB`;}
function historySubmissionJson(r){return{publicId:r.public_id,submitterName:r.submitter_name,submitterEmail:r.submitter_email,category:r.category,historicalDate:r.historical_date||"",description:r.description,status:r.status,reviewNotes:r.review_notes||"",reviewedBy:r.reviewed_by||"",reviewedAt:r.reviewed_at||null,actedUponAt:r.acted_upon_at||null,createdAt:r.created_at,updatedAt:r.updated_at,fileCount:Number(r.file_count)||0,totalBytes:Number(r.total_bytes)||0};}
function historyFileJson(f){return{id:Number(f.id),originalFilename:f.original_filename,contentType:f.content_type||"application/octet-stream",sizeBytes:Number(f.size_bytes)||0,createdAt:f.created_at};}
async function requireAdmin(request,env){const s=await requireSession(request,env);return s&&s.role==="admin"&&Number(s.priority)<=2?s:null;}
async function requirePrimaryAdmin(request,env){const s=await requireSession(request,env);return s&&s.role==="admin"&&Number(s.priority)===1?s:null;}
function normalizePriority(v){const n=Number(v);return [1,2,3].includes(n)?n:null;}
function accessLabel(p){return p===1?"Primary Admin":p===2?"Secondary Admin":"Editor";}
function canManagePriority(actor,targetPriority){const p=Number(actor?.priority)||3;return p===1 || (p===2 && Number(targetPriority)>=2);}
function publicUser(u){return{id:u.id,email:u.email,displayName:u.display_name,role:u.role,priority:Number(u.priority)||3,accessLabel:accessLabel(Number(u.priority)||3)};}
function publicSessionUser(s){return{id:s.user_id,email:s.email,displayName:s.display_name,role:s.role,priority:Number(s.priority)||3,accessLabel:accessLabel(Number(s.priority)||3)};}
function mapUserRow(u){return{id:u.id,email:u.email,displayName:u.display_name,role:u.role,priority:Number(u.priority)||3,accessLabel:accessLabel(Number(u.priority)||3),active:Boolean(u.active),createdAt:u.created_at,updatedAt:u.updated_at,lastLoginAt:u.last_login_at};}
function mapInviteRow(i){return{id:i.id,email:i.email,displayName:i.display_name,role:i.role,priority:Number(i.priority)||3,accessLabel:accessLabel(Number(i.priority)||3),createdBy:i.created_by,createdAt:i.created_at,expiresAt:i.expires_at,usedAt:i.used_at,revokedAt:i.revoked_at};}
async function getInviteByToken(env,token){const h=await sha256Hex(token);return env.DB.prepare(`SELECT id,email,display_name,role,priority,created_by,created_at,expires_at,used_at,revoked_at FROM admin_invites WHERE token_hash=? LIMIT 1`).bind(h).first();}
function inviteState(i){if(i.used_at)return"used";if(i.revoked_at)return"revoked";const t=Date.parse(i.expires_at);if(!Number.isFinite(t)||t<=Date.now())return"expired";return"pending";}


function mapManagedImage(r){return{id:r.id,digest:r.digest||"",originalName:r.original_name||"",webFile:r.web_file||"",batchId:r.batch_id||"",width:Number(r.width)||0,height:Number(r.height)||0,rotation:normalizeRotation(r.rotation),year:r.year==null?null:Number(r.year),decade:r.decade||"",alt:r.alt||"",caption:r.caption||"",event:r.event||"",source:r.source||"",hidden:Boolean(r.hidden),legacy:Boolean(r.legacy),thumbUrl:r.thumb_url||"",displayUrl:r.display_url||"",createdAt:r.created_at,updatedAt:r.updated_at};}
function galleryStats(imgs){return{total:imgs.length,visible:imgs.filter(x=>!x.hidden).length,hidden:imgs.filter(x=>x.hidden).length,needsYear:imgs.filter(x=>x.year==null).length,legacy:imgs.filter(x=>x.legacy).length};}
function cleanGalleryChanges(changes,current){changes=changes&&typeof changes==="object"?changes:{};let year=changes.year===undefined?(current.year==null?null:Number(current.year)):(changes.year===null||changes.year===""?null:Number(changes.year));if(year!==null&&(!Number.isInteger(year)||year<1900||year>2099))return{error:"Year must be blank or between 1900 and 2099."};const str=(k,max)=>String(changes[k]??current[k]??"").trim().slice(0,max);return{year,decade:year===null?"":`${Math.floor(year/10)*10}s`,alt:str("alt",300),caption:str("caption",1000),event:str("event",200),source:str("source",200),hidden:changes.hidden===undefined?Boolean(current.hidden):Boolean(changes.hidden),rotation:normalizeRotation(changes.rotation===undefined?current.rotation:changes.rotation)};}
function managedSnapshot(r){return{year:r.year==null?null:Number(r.year),decade:r.decade||"",alt:r.alt||"",caption:r.caption||"",event:r.event||"",source:r.source||"",hidden:Boolean(r.hidden),rotation:normalizeRotation(r.rotation)};}
function galleryDiff(current,clean){const before=managedSnapshot(current),after={year:clean.year,decade:clean.decade,alt:clean.alt,caption:clean.caption,event:clean.event,source:clean.source,hidden:Boolean(clean.hidden),rotation:clean.rotation};const out={};for(const k of Object.keys(after))if(String(before[k]??"")!==String(after[k]??""))out[k]={from:before[k],to:after[k]};return out;}
function mapGalleryChangeRequest(r){let current={},proposed={};try{current=JSON.parse(r.current_json||"{}")}catch{}try{proposed=JSON.parse(r.proposed_json||"{}")}catch{}const labels={submitted:"Awaiting Review",changes_requested:"Changes Requested",approved:"Approved",rejected:"Rejected",cancelled:"Cancelled"};return{id:r.id,imageId:r.image_id,status:r.status,statusLabel:labels[r.status]||r.status,current,proposed,requestNote:r.request_note||"",reviewNote:r.review_note||"",requestedBy:Number(r.requested_by)||null,requestedByName:r.requester_name||"",requestedByEmail:r.requester_email||"",createdAt:r.created_at,reviewedAt:r.reviewed_at,image:{originalName:r.original_name||"",thumbUrl:r.thumb_url||"",displayUrl:r.display_url||"",legacy:Boolean(r.legacy)}};}
function galleryActionLabel(a){return({gallery_image_updated:"Image updated",gallery_year_changed:"Year changed",gallery_image_hidden:"Hidden from gallery",gallery_image_restored:"Restored to gallery",gallery_change_requested:"Change requested",gallery_change_approved:"Change approved",gallery_change_returned:"Changes requested by Admin",gallery_change_rejected:"Change rejected"})[a]||String(a||"").replaceAll("_"," ");}
function galleryAuditSummary(action,d){if(d?.changes){const parts=Object.entries(d.changes).map(([k,v])=>`${k}: ${v?.from??"—"} → ${v?.to??"—"}`);return parts.join("; ");}if(action==="gallery_year_changed")return`Year: ${d?.from??"—"} → ${d?.to??"—"}`;if(action==="gallery_image_hidden")return"Image hidden from public gallery; R2 files preserved.";if(action==="gallery_image_restored")return"Image restored to public gallery.";return d?.note||"";}


function normalizeContentType(v){v=String(v||"").trim().toLowerCase();return v==="blog"||v==="newsletter"?v:"";}
function normalizeContentStatus(v){v=String(v||"").trim().toLowerCase();return ["draft","submitted","changes_requested","published","archived","rejected"].includes(v)?v:"";}
function slugifyContent(v){return String(v||"").toLowerCase().trim().replace(/[’']/g,"").replace(/[^a-z0-9]+/g,"-").replace(/^-+|-+$/g,"").slice(0,120);}
function cleanContentPost(body){
  const type=normalizeContentType(body.type),title=String(body.title||"").trim().slice(0,180);
  if(!type)return{error:"Post type must be blog or newsletter."};if(title.length<2)return{error:"Title is required."};
  const slug=slugifyContent(body.slug||title);if(slug.length<2)return{error:"Enter a usable URL slug."};
  let cats=body.categories;if(typeof cats==="string")cats=cats.split(",");if(!Array.isArray(cats))cats=[];cats=[...new Set(cats.map(x=>String(x||"").trim()).filter(Boolean))].slice(0,20);
  const publicationDate=String(body.publicationDate||body.publication_date||"").trim()||null;if(publicationDate&&!/^\d{4}-\d{2}-\d{2}$/.test(publicationDate))return{error:"Publication date must use YYYY-MM-DD."};
  let year=body.year===null||body.year===""||body.year===undefined?null:Number(body.year);if(year!==null&&(!Number.isInteger(year)||year<1900||year>2099))return{error:"Year must be blank or between 1900 and 2099."};
  const season=type==="newsletter"?String(body.season||"").trim().slice(0,30):"";
  return{type,title,slug,summary:String(body.summary||"").trim().slice(0,2000),authorName:String(body.authorName||body.author_name||"").trim().slice(0,120),authorImageUrl:String(body.authorImageUrl||body.author_image_url||"").trim().slice(0,1000),categories:cats,season,year:type==="newsletter"?year:null,publicationDate,featured:Boolean(body.featured),currentNewsletter:type==="newsletter"&&Boolean(body.currentNewsletter??body.current_newsletter)};
}
function mapContentPost(r){let categories=[];try{categories=JSON.parse(r.categories_json||"[]");if(!Array.isArray(categories))categories=[];}catch{}return{id:r.id,type:r.type,slug:r.slug,title:r.title,summary:r.summary||"",authorName:r.author_name||"",authorImageUrl:r.author_image_url||"",categories,season:r.season||"",year:r.year==null?null:Number(r.year),publicationDate:r.publication_date||"",pdfKey:r.pdf_key||"",coverKey:r.cover_key||"",status:r.status,featured:Boolean(r.featured),currentNewsletter:Boolean(r.current_newsletter),createdBy:Number(r.created_by)||null,createdByName:r.creator_name||"",createdByEmail:r.creator_email||"",submittedBy:r.submitted_by==null?null:Number(r.submitted_by),submittedByName:r.submitter_name||"",approvedBy:r.approved_by==null?null:Number(r.approved_by),approvedByName:r.approver_name||"",reviewNote:r.review_note||"",createdAt:r.created_at,updatedAt:r.updated_at,submittedAt:r.submitted_at,publishedAt:r.published_at,archivedAt:r.archived_at};}

function mapContentAsset(r){return{id:r.id,postId:r.post_id,kind:r.kind,version:Number(r.version)||1,storageKey:r.storage_key||"",originalName:r.original_name||"",contentType:r.content_type||"application/octet-stream",sizeBytes:Number(r.size_bytes)||0,sha256:r.sha256||"",status:r.status||"",uploadedBy:Number(r.uploaded_by)||null,uploaderName:r.uploader_name||"",uploaderEmail:r.uploader_email||"",createdAt:r.created_at,publishedAt:r.published_at};}
async function getContentPostRow(env,id){return await env.DB.prepare(`SELECT p.*,u.display_name AS creator_name,u.email AS creator_email,s.display_name AS submitter_name,a.display_name AS approver_name FROM content_posts p LEFT JOIN admin_users u ON u.id=p.created_by LEFT JOIN admin_users s ON s.id=p.submitted_by LEFT JOIN admin_users a ON a.id=p.approved_by WHERE p.id=? LIMIT 1`).bind(id).first();}
async function getCurrentContentAssets(env,postId,status){const rows=(await env.DB.prepare(`SELECT * FROM content_assets WHERE post_id=? AND status=? ORDER BY version DESC,created_at DESC`).bind(postId,status).all()).results||[];const out={pdf:null,cover:null};for(const r of rows){if(!out[r.kind])out[r.kind]=r;}return out;}
function safePublicationFilename(v){const raw=String(v||"").trim().split(/[\\/]/).pop()||"";return raw.replace(/[^a-zA-Z0-9._ -]+/g,"_").replace(/\s+/g,"-").slice(0,180);}
function guessPublicationContentType(name){const n=String(name||"").toLowerCase();if(n.endsWith(".pdf"))return"application/pdf";if(n.endsWith(".png"))return"image/png";if(n.endsWith(".jpg")||n.endsWith(".jpeg"))return"image/jpeg";if(n.endsWith(".webp"))return"image/webp";return"application/octet-stream";}
function publicationExtension(name,type,kind){const n=String(name||"").toLowerCase();if(kind==="pdf")return"pdf";if(type==="image/png"||n.endsWith(".png"))return"png";if(type==="image/jpeg"||n.endsWith(".jpg")||n.endsWith(".jpeg"))return"jpg";return"webp";}
function publicationObjectResponse(obj,contentType,filename,corsOrigin,isPublic){const h={"Content-Type":contentType||obj.httpMetadata?.contentType||"application/octet-stream","Access-Control-Allow-Origin":corsOrigin,"Vary":"Origin","Cache-Control":isPublic?"public, max-age=3600":"private, no-store","Content-Disposition":`inline; filename="${String(filename||"file").replace(/[\"\\]/g,"_")}"`};if(obj.etag)h.ETag=obj.etag;return new Response(obj.body,{status:200,headers:h});}
function mapPublicContentPost(r,origin){const p=mapContentPost(r);return{id:p.id,type:p.type,slug:p.slug,title:p.title,summary:p.summary,authorName:p.authorName,authorImageUrl:p.authorImageUrl,categories:p.categories,season:p.season,year:p.year,publicationDate:p.publicationDate,featured:p.featured,currentNewsletter:p.currentNewsletter,publishedAt:p.publishedAt,pdfUrl:p.pdfKey?`${origin}/api/publication/file?id=${encodeURIComponent(p.id)}&kind=pdf`:"",coverUrl:p.coverKey?`${origin}/api/publication/file?id=${encodeURIComponent(p.id)}&kind=cover`:""};}
async function sha256HexBytes(buf){const hash=await crypto.subtle.digest("SHA-256",buf);return[...new Uint8Array(hash)].map(b=>b.toString(16).padStart(2,"0")).join("");}


const NOTIFICATION_GROUPS={
  approval_required:[1],
  alumni_records:[1,2]
};
async function notifyAdminGroup(env,group,message){
  const priorities=NOTIFICATION_GROUPS[group];
  if(!priorities?.length)return{ok:false,error:"Unknown notification group."};
  const placeholders=priorities.map(()=>"?").join(",");
  const rows=(await env.DB.prepare(`SELECT id,email,display_name,priority FROM admin_users WHERE active=1 AND role='admin' AND priority IN (${placeholders}) ORDER BY priority,lower(email)`).bind(...priorities).all()).results||[];
  const recipients=[...new Set(rows.map(r=>normalizeEmail(r.email)).filter(isEmail))];
  if(!recipients.length)return{ok:true,skipped:true,reason:"No active recipients."};
  return sendTransactionalEmail(env,{to:recipients,subject:message.subject,text:message.text,html:adminEmailTemplate(message.heading,message.bodyHtml)},
    {category:group,entityType:message.entityType,entityId:message.entityId,actorUserId:message.actorUserId});
}
async function notifyUserById(env,userId,message){
  const id=Number(userId);
  if(!Number.isInteger(id)||id<1)return{ok:true,skipped:true,reason:"No submitting user."};
  const user=await env.DB.prepare(`SELECT id,email,display_name,active FROM admin_users WHERE id=? LIMIT 1`).bind(id).first();
  const recipient=normalizeEmail(user?.email||"");
  if(!user||!isEmail(recipient))return{ok:true,skipped:true,reason:"Submitting user has no valid email."};
  return sendTransactionalEmail(env,{to:recipient,subject:message.subject,text:message.text,html:adminEmailTemplate(message.heading,message.bodyHtml)},{category:message.category||"submission_decision",entityType:message.entityType,entityId:message.entityId,actorUserId:message.actorUserId});
}
async function sendTransactionalEmail(env,message,meta={}){
  const username=normalizeEmail(meta.authUsername||env.PURELYMAIL_USER||"admin@tczk.org");
  const password=String(meta.authPassword||env.PURELYMAIL_APP_PASSWORD||"");
  const to=[...new Set((Array.isArray(message.to)?message.to:[message.to]).map(normalizeEmail).filter(isEmail))];
  if(!username||!password)return await logEmailResult(env,{...meta,to,subject:message.subject},false,"Purelymail credentials are not configured.");
  if(!to.length)return await logEmailResult(env,{...meta,to,subject:message.subject},false,"No valid recipients.");
  try{
    // Keep each recipient private and make failures independently traceable.
    for(const recipient of to){
      await smtpSendPurelymail({username,password,to:recipient,subject:message.subject,text:message.text||"",html:message.html||"",replyTo:message.replyTo||"",fromName:message.fromName||"TCZK Admin"});
    }
    return await logEmailResult(env,{...meta,to,subject:message.subject},true,null);
  }catch(err){
    console.error("Transactional email failed",err);
    return await logEmailResult(env,{...meta,to,subject:message.subject},false,String(err?.message||err).slice(0,1000));
  }
}
async function logEmailResult(env,meta,ok,error){
  try{await env.DB.prepare(`INSERT INTO email_delivery_log (category,entity_type,entity_id,actor_user_id,recipients_json,subject,status,error) VALUES (?,?,?,?,?,?,?,?)`)
    .bind(String(meta.category||"transactional"),String(meta.entityType||""),String(meta.entityId||""),meta.actorUserId==null?null:Number(meta.actorUserId),JSON.stringify(meta.to||[]),String(meta.subject||"").slice(0,300),ok?"sent":"failed",error||null).run();}catch(e){console.warn("Email log write failed",e);}
  return ok?{ok:true}:{ok:false,error};
}
async function smtpSendPurelymail({username,password,to,subject,text,html,replyTo="",fromName="TCZK Admin"}){
  const socket = connect(
  { hostname: "smtp.purelymail.com", port: 465 },{secureTransport: "on",allowHalfOpen: false});
  await socket.opened;
  const reader=socket.readable.getReader(),writer=socket.writable.getWriter(),decoder=new TextDecoder(),encoder=new TextEncoder();
  let buffer="";
  const readResponse=async(expected)=>{
    while(true){
      const lines=buffer.split(/\r?\n/);buffer=lines.pop()||"";
      for(const line of lines){
        const m=line.match(/^(\d{3})([ -])(.*)$/);if(!m)continue;
        if(m[2]===" "){
          const code=Number(m[1]);
          if(expected&&!expected.includes(code))throw new Error(`SMTP ${code}: ${m[3]}`);
          return{code,message:m[3]};
        }
      }
      const {value,done}=await reader.read();if(done)throw new Error("SMTP connection closed unexpectedly.");buffer+=decoder.decode(value,{stream:true});
    }
  };
  const command=async(cmd,expected)=>{await writer.write(encoder.encode(cmd+"\r\n"));return readResponse(expected);};
  try{
    await readResponse([220]);
    await command("EHLO tczk.org",[250]);
    await command("AUTH LOGIN",[334]);
    await command(btoa(username),[334]);
    await command(btoa(password),[235]);
    await command(`MAIL FROM:<${username}>`,[250]);
    await command(`RCPT TO:<${to}>`,[250,251]);
    await command("DATA",[354]);
    const boundary=`tczk_${crypto.randomUUID().replace(/-/g,"")}`;
    const safeSubject=String(subject||"TCZK Admin notification").replace(/[\r\n]+/g," ").slice(0,300);
    const plain=String(text||"").replace(/\r?\n/g,"\r\n");
    const htmlBody=String(html||"");
    let mime=[
      `From: ${String(fromName||"TCZK Admin").replace(/[\r\n]+/g," ").slice(0,80)} <${username}>`,`To: <${to}>`,
      ...(isEmail(normalizeEmail(replyTo))?[`Reply-To: <${normalizeEmail(replyTo)}>`]:[]),
      `Subject: ${safeSubject}`,`Date: ${new Date().toUTCString()}`,`Message-ID: <${crypto.randomUUID()}@tczk.org>`,`MIME-Version: 1.0`,
      `Content-Type: multipart/alternative; boundary="${boundary}"`,"",`--${boundary}`,
      `Content-Type: text/plain; charset=UTF-8`,`Content-Transfer-Encoding: 8bit`,"",plain,"",
      `--${boundary}`,`Content-Type: text/html; charset=UTF-8`,`Content-Transfer-Encoding: 8bit`,"",htmlBody,"",`--${boundary}--`,""
    ].join("\r\n");
    mime=mime.split("\r\n").map(line=>line.startsWith(".")?"."+line:line).join("\r\n");
    await writer.write(encoder.encode(mime+"\r\n.\r\n"));
    await readResponse([250]);
    await command("QUIT",[221]);
  }finally{try{reader.releaseLock();writer.releaseLock();await socket.close();}catch{}}
}
function adminEmailTemplate(heading,bodyHtml){return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0;background:#f4f4f4;font-family:Arial,Helvetica,sans-serif;color:#222"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f4f4f4;padding:24px 12px"><tr><td align="center"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:620px;background:#fff;border-radius:8px;overflow:hidden"><tr><td style="background:#b5121b;color:#fff;padding:22px 28px"><div style="font-size:13px;letter-spacing:.12em;text-transform:uppercase">Theta Chi · Zeta Kappa</div><div style="font-size:24px;font-weight:700;margin-top:5px">${escapeHtml(heading)}</div></td></tr><tr><td style="padding:28px;line-height:1.55">${bodyHtml}<p style="margin-top:28px;color:#666;font-size:12px">This is an automated message from TCZK Admin.</p></td></tr></table></td></tr></table></body></html>`;}
function emailButton(label,url){const safe=escapeHtml(url);return `<p style="margin:24px 0"><a href="${safe}" style="display:inline-block;background:#b5121b;color:#fff;text-decoration:none;font-weight:700;padding:12px 18px;border-radius:5px">${escapeHtml(label)}</a></p><p style="font-size:12px;color:#666;word-break:break-all">${safe}</p>`;}
function escapeHtml(v){return String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));}

function normalizeRotation(v){const n=Number(v)||0;return((Math.round(n/90)*90)%360+360)%360;}
function mapApprovalBatch(b){const status=String(b.status||"");const labels={draft_uploading:"Uploading",submitted:"Awaiting Approval",changes_requested:"Changes Requested",published:"Published",cancelled:"Cancelled"};return{id:b.id,sourceBatchId:b.source_batch_id,processorVersion:b.processor_version,sourceFileName:b.source_file_name,status,statusLabel:labels[status]||status,imageCount:Number(b.image_count)||0,activeCount:Number(b.active_count)||0,removedCount:Number(b.removed_count)||0,submittedBy:Number(b.submitted_by)||null,submittedByName:b.submitter_name||"",submittedByEmail:b.submitter_email||"",createdAt:b.created_at,submittedAt:b.submitted_at,reviewedBy:b.reviewed_by,reviewedAt:b.reviewed_at,reviewNote:b.review_note,publishedAt:b.published_at};}
function mapApprovalImage(i){return{sourceId:i.source_id,digest:i.digest,originalName:i.original_name,webFile:i.web_file,width:Number(i.width)||0,height:Number(i.height)||0,rotation:Number(i.rotation)||0,year:i.year==null?null:Number(i.year),decade:i.decade||"",alt:i.alt||"",removed:Boolean(i.removed),sortOrder:Number(i.sort_order)||0};}
async function deleteStaging(env,batchId){let cursor;do{const page=await env.GALLERY.list({prefix:`staging/${batchId}/`,cursor,limit:1000});const keys=(page.objects||[]).map(o=>o.key);if(keys.length)await env.GALLERY.delete(keys);cursor=page.truncated?page.cursor:undefined;}while(cursor);}
function normalizeEmail(v){return String(v||"").trim().toLowerCase();}
function isEmail(v){return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)&&v.length<=254;}
function normalizeRole(v){v=String(v||"").trim().toLowerCase();return v==="admin"||v==="editor"?v:"";}
function validatePassword(p){if(p.length<12)return"Password must be at least 12 characters.";if(p.length>128)return"Password must be 128 characters or fewer.";return"";}
async function makePasswordRecord(password){const iterations=100000,salt=crypto.getRandomValues(new Uint8Array(16)),enc=new TextEncoder();const km=await crypto.subtle.importKey("raw",enc.encode(password),"PBKDF2",false,["deriveBits"]);const bits=await crypto.subtle.deriveBits({name:"PBKDF2",hash:"SHA-256",salt,iterations},km,256);return`pbkdf2_sha256$${iterations}$${bytesToBase64Url(salt)}$${bytesToBase64Url(new Uint8Array(bits))}`;}
async function verifyPassword(password,record){const parts=String(record||"").split("$");if(parts.length!==4||parts[0]!=="pbkdf2_sha256")return false;const iterations=Number(parts[1]),salt=base64UrlToBytes(parts[2]),expected=base64UrlToBytes(parts[3]);if(!Number.isInteger(iterations)||iterations<100000||iterations>100000||expected.length<16)return false;const enc=new TextEncoder(),km=await crypto.subtle.importKey("raw",enc.encode(password),"PBKDF2",false,["deriveBits"]);const bits=await crypto.subtle.deriveBits({name:"PBKDF2",hash:"SHA-256",salt,iterations},km,expected.length*8);return timingSafeEqual(new Uint8Array(bits),expected);}
function timingSafeEqual(a,b){if(a.length!==b.length)return false;let d=0;for(let i=0;i<a.length;i++)d|=a[i]^b[i];return d===0;}
function base64UrlToBytes(input){let s=String(input).replace(/-/g,"+").replace(/_/g,"/");while(s.length%4)s+="=";const bin=atob(s),out=new Uint8Array(bin.length);for(let i=0;i<bin.length;i++)out[i]=bin.charCodeAt(i);return out;}
function bytesToBase64Url(arr){let bin="";arr.forEach(b=>bin+=String.fromCharCode(b));return btoa(bin).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/g,"");}
function randomToken(bytes=32){return bytesToBase64Url(crypto.getRandomValues(new Uint8Array(bytes)));}
async function sha256Hex(text){const buf=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(text));return[...new Uint8Array(buf)].map(b=>b.toString(16).padStart(2,"0")).join("");}
function bearerToken(request){const m=(request.headers.get("Authorization")||"").match(/^Bearer\s+(.+)$/i);return m?m[1].trim():"";}
async function safeJson(request){try{return await request.json();}catch{return null;}}
function sleep(ms){return new Promise(r=>setTimeout(r,ms));}
async function writeAudit(env,userId,action,entityType,entityId,details){try{await env.DB.prepare(`INSERT INTO audit_log (user_id,action,entity_type,entity_id,details) VALUES (?,?,?,?,?)`).bind(userId,action,entityType,entityId,JSON.stringify(details||{})).run();}catch(e){console.warn("Audit write failed",e);}}
function json(data,status=200,headers={}){return new Response(JSON.stringify(data,null,2),{status,headers});}
