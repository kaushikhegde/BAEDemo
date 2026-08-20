// Data access for the platform tables — identity, projects, access, audit,
// chats, run events.
//
// A separate module from core/repo.ts rather than an extension of it. repo.ts
// is the ENGINE's store: agents, issues, runs, gates — the things a workflow
// touches while it executes. These are the things a PRODUCT touches: who is
// logged in, which projects exist, who may see them, what everyone did. They
// have different lifetimes, different callers, and only one join between them
// (`issues.project_id`), so keeping them apart keeps either one readable.

import type { Db } from "./db.js";
import { newId } from "./ids.js";
import {
  hashToken, mintToken, tokenPrefix, effectiveProjectRole, sessionExpiry,
  type MintedToken, type ProjectRole,
} from "./auth.js";

export interface UserRow {
  id: string; company_id: string; email: string; name: string | null;
  password_hash: string | null; role: string; status: string;
  created_at: string; updated_at: string;
}
export interface ProjectRow {
  id: string; company_id: string; name: string; description: string | null;
  website: string | null; theme: Record<string, unknown>;
  created_by: string | null; created_at: string; updated_at: string; archived_at: string | null;
}
export interface FeatureRow {
  id: string; project_id: string; name: string;
  created_by: string | null; created_at: string; archived_at: string | null;
}
export interface InstallationRow {
  id: string; company_id: string; user_id: string | null; machine_id: string;
  hostname: string | null; os: string | null; plugin_version: string | null;
  installed_at: string; last_seen_at: string | null; revoked_at: string | null;
}
export interface ActionRow {
  id: string; company_id: string; project_id: string | null; feature_id: string | null;
  issue_id: string | null; user_id: string | null; agent_key: string | null;
  installation_id: string | null; verb: string; target_type: string | null;
  target_id: string | null; detail: Record<string, unknown>; created_at: string;
}
export interface ConversationRow {
  id: string; company_id: string; project_id: string | null; feature_id: string | null;
  user_id: string | null; title: string | null; created_at: string; updated_at: string;
}
export interface MessageRow {
  id: string; conversation_id: string; seq: number; role: string;
  content: unknown; adapter: string | null; model: string | null;
  input_tokens: string | null; output_tokens: string | null;
  cost_usd: string | null; created_at: string;
}

/** Who a request is acting as, once a credential has been resolved. */
export interface Principal {
  user: UserRow;
  /** The token row's id when authenticated by token, null for a session. */
  tokenId: string | null;
  installationId: string | null;
}

export interface SpendRow {
  project_id: string | null; project_name: string | null;
  agent_key: string | null; adapter: string | null; user_id: string | null;
  run_count: string; input_tokens: string; output_tokens: string; cost_usd: string;
}

const asJson = (v: unknown): Record<string, unknown> =>
  typeof v === "string" ? JSON.parse(v) : ((v ?? {}) as Record<string, unknown>);

export function createPlatformRepo(db: Db) {
  return {
    // ------------------------------------------------------------- users

    async createUser(input: {
      companyId: string; email: string; name?: string | null;
      passwordHash?: string | null; role?: string;
    }): Promise<UserRow> {
      const id = newId();
      const { rows } = await db.query<UserRow>(
        `insert into users (id, company_id, email, name, password_hash, role)
         values ($1,$2,$3,$4,$5,$6) returning *`,
        [id, input.companyId, input.email.toLowerCase().trim(), input.name ?? null,
         input.passwordHash ?? null, input.role ?? "member"]);
      return rows[0];
    },

    async getUserByEmail(companyId: string, email: string): Promise<UserRow | null> {
      const { rows } = await db.query<UserRow>(
        `select * from users where company_id=$1 and email=$2`, [companyId, email.toLowerCase().trim()]);
      return rows[0] ?? null;
    },

    async getUser(id: string): Promise<UserRow | null> {
      const { rows } = await db.query<UserRow>(`select * from users where id=$1`, [id]);
      return rows[0] ?? null;
    },

    async listUsers(companyId: string): Promise<UserRow[]> {
      const { rows } = await db.query<UserRow>(
        `select * from users where company_id=$1 order by created_at`, [companyId]);
      return rows;
    },

    async updateUser(id: string, patch: {
      name?: string | null; role?: string; status?: string; passwordHash?: string | null;
    }): Promise<UserRow | null> {
      const sets: string[] = []; const params: unknown[] = [];
      const set = (col: string, v: unknown) => { params.push(v); sets.push(`${col}=$${params.length}`); };
      if (patch.name !== undefined) set("name", patch.name);
      if (patch.role !== undefined) set("role", patch.role);
      if (patch.status !== undefined) set("status", patch.status);
      if (patch.passwordHash !== undefined) set("password_hash", patch.passwordHash);
      if (!sets.length) return this.getUser(id);
      params.push(id);
      const { rows } = await db.query<UserRow>(
        `update users set ${sets.join(", ")}, updated_at=now() where id=$${params.length} returning *`, params);
      return rows[0] ?? null;
    },

    /** True when no user exists yet — the only moment bootstrapping an admin is allowed. */
    async isUnclaimed(companyId: string): Promise<boolean> {
      const { rows } = await db.query<{ n: string }>(
        `select count(*)::text as n from users where company_id=$1`, [companyId]);
      return rows[0].n === "0";
    },

    // ------------------------------------------------------------ tokens

    async createToken(userId: string, name: string, expiresAt?: Date | null):
      Promise<{ row: { id: string; prefix: string }; secret: string }> {
      const t: MintedToken = mintToken();
      const id = newId();
      await db.query(
        `insert into api_tokens (id, user_id, name, prefix, token_hash, expires_at)
         values ($1,$2,$3,$4,$5,$6)`,
        [id, userId, name, t.prefix, t.hash, expiresAt ?? null]);
      // The secret is returned here and never again — nothing stores it.
      return { row: { id, prefix: t.prefix }, secret: t.secret };
    },

    async listTokens(userId: string) {
      const { rows } = await db.query(
        `select id, name, prefix, last_used_at, expires_at, revoked_at, created_at
           from api_tokens where user_id=$1 order by created_at desc`, [userId]);
      return rows;
    },

    async revokeToken(id: string, userId?: string): Promise<boolean> {
      const params: unknown[] = [id];
      let sql = `update api_tokens set revoked_at=now() where id=$1 and revoked_at is null`;
      if (userId) { params.push(userId); sql += ` and user_id=$${params.length}`; }
      const { rows } = await db.query<{ id: string }>(sql + ` returning id`, params);
      return rows.length > 0;
    },

    /**
     * Resolve a presented token to a principal, or null.
     *
     * Looked up by hash, not by prefix: the prefix is for humans reading a
     * list, and searching by it would make two tokens sharing one a real
     * ambiguity. Revocation and expiry are checked in SQL so a revoked token
     * cannot be authenticated by a code path that forgot to look.
     */
    async principalFromToken(secret: string): Promise<Principal | null> {
      const { rows } = await db.query<UserRow & { token_id: string }>(
        `select u.*, t.id as token_id
           from api_tokens t join users u on u.id = t.user_id
          where t.token_hash = $1
            and t.revoked_at is null
            and (t.expires_at is null or t.expires_at > now())
            and u.status = 'active'`,
        [hashToken(secret)]);
      if (!rows[0]) return null;
      const { token_id, ...user } = rows[0];
      // Best-effort: a failed touch must not fail the request it authenticated.
      await db.query(`update api_tokens set last_used_at=now() where id=$1`, [token_id]).catch(() => {});
      return { user: user as UserRow, tokenId: token_id, installationId: null };
    },

    // ---------------------------------------------------------- sessions

    async createSession(userId: string): Promise<{ secret: string; expiresAt: Date }> {
      const t = mintToken();
      const expiresAt = sessionExpiry();
      await db.query(
        `insert into sessions (id, user_id, token_hash, expires_at) values ($1,$2,$3,$4)`,
        [newId(), userId, t.hash, expiresAt]);
      return { secret: t.secret, expiresAt };
    },

    async principalFromSession(secret: string): Promise<Principal | null> {
      const { rows } = await db.query<UserRow>(
        `select u.* from sessions s join users u on u.id = s.user_id
          where s.token_hash = $1 and s.expires_at > now() and u.status = 'active'`,
        [hashToken(secret)]);
      return rows[0] ? { user: rows[0], tokenId: null, installationId: null } : null;
    },

    async destroySession(secret: string): Promise<void> {
      await db.query(`delete from sessions where token_hash=$1`, [hashToken(secret)]);
    },

    async purgeExpiredSessions(): Promise<number> {
      const { rows } = await db.query<{ id: string }>(
        `delete from sessions where expires_at <= now() returning id`);
      return rows.length;
    },

    // ---------------------------------------------------------- projects

    async createProject(input: {
      companyId: string; name: string; description?: string | null;
      website?: string | null; createdBy?: string | null;
    }): Promise<ProjectRow> {
      const id = newId();
      const { rows } = await db.query<ProjectRow>(
        `insert into projects (id, company_id, name, description, website, created_by)
         values ($1,$2,$3,$4,$5,$6) returning *`,
        [id, input.companyId, input.name, input.description ?? null,
         input.website ?? null, input.createdBy ?? null]);
      // The creator owns what they created. Without this a project is
      // immediately inaccessible to the person who just made it.
      if (input.createdBy) {
        await db.query(
          `insert into project_members (project_id, user_id, role, granted_by)
           values ($1,$2,'owner',$2) on conflict do nothing`, [id, input.createdBy]);
      }
      return { ...rows[0], theme: asJson(rows[0].theme) };
    },

    async getProject(id: string): Promise<ProjectRow | null> {
      const { rows } = await db.query<ProjectRow>(`select * from projects where id=$1`, [id]);
      return rows[0] ? { ...rows[0], theme: asJson(rows[0].theme) } : null;
    },

    async getProjectByName(companyId: string, name: string): Promise<ProjectRow | null> {
      const { rows } = await db.query<ProjectRow>(
        `select * from projects where company_id=$1 and name=$2`, [companyId, name]);
      return rows[0] ? { ...rows[0], theme: asJson(rows[0].theme) } : null;
    },

    /**
     * Projects a user may see. An admin sees every project; anyone else sees
     * the ones they hold a membership on. The filter is in SQL rather than
     * applied afterwards so a listing endpoint cannot leak by forgetting it.
     */
    async listProjects(companyId: string, opts: { userId?: string; isAdmin?: boolean } = {}):
      Promise<ProjectRow[]> {
      if (opts.isAdmin || !opts.userId) {
        const { rows } = await db.query<ProjectRow>(
          `select * from projects where company_id=$1 and archived_at is null order by name`, [companyId]);
        return rows.map(r => ({ ...r, theme: asJson(r.theme) }));
      }
      const { rows } = await db.query<ProjectRow>(
        `select p.* from projects p join project_members m on m.project_id = p.id
          where p.company_id=$1 and p.archived_at is null and m.user_id=$2 order by p.name`,
        [companyId, opts.userId]);
      return rows.map(r => ({ ...r, theme: asJson(r.theme) }));
    },

    async updateProject(id: string, patch: {
      description?: string | null; website?: string | null; theme?: Record<string, unknown>;
    }): Promise<ProjectRow | null> {
      const sets: string[] = []; const params: unknown[] = [];
      const set = (col: string, v: unknown) => { params.push(v); sets.push(`${col}=$${params.length}`); };
      if (patch.description !== undefined) set("description", patch.description);
      if (patch.website !== undefined) set("website", patch.website);
      if (patch.theme !== undefined) set("theme", JSON.stringify(patch.theme));
      if (!sets.length) return this.getProject(id);
      params.push(id);
      const { rows } = await db.query<ProjectRow>(
        `update projects set ${sets.join(", ")}, updated_at=now() where id=$${params.length} returning *`, params);
      return rows[0] ? { ...rows[0], theme: asJson(rows[0].theme) } : null;
    },

    async archiveProject(id: string): Promise<boolean> {
      const { rows } = await db.query<{ id: string }>(
        `update projects set archived_at=now() where id=$1 and archived_at is null returning id`, [id]);
      return rows.length > 0;
    },

    // ---------------------------------------------------------- features

    async createFeature(input: { projectId: string; name: string; createdBy?: string | null }):
      Promise<FeatureRow> {
      const { rows } = await db.query<FeatureRow>(
        `insert into features (id, project_id, name, created_by) values ($1,$2,$3,$4) returning *`,
        [newId(), input.projectId, input.name, input.createdBy ?? null]);
      return rows[0];
    },

    async listFeatures(projectId: string): Promise<FeatureRow[]> {
      const { rows } = await db.query<FeatureRow>(
        `select * from features where project_id=$1 and archived_at is null order by name`, [projectId]);
      return rows;
    },

    async getFeatureByName(projectId: string, name: string): Promise<FeatureRow | null> {
      const { rows } = await db.query<FeatureRow>(
        `select * from features where project_id=$1 and name=$2`, [projectId, name]);
      return rows[0] ?? null;
    },

    // ------------------------------------------------------------ access

    async setMember(projectId: string, userId: string, role: ProjectRole, grantedBy?: string | null):
      Promise<void> {
      await db.query(
        `insert into project_members (project_id, user_id, role, granted_by) values ($1,$2,$3,$4)
         on conflict (project_id, user_id) do update set role=excluded.role, granted_by=excluded.granted_by`,
        [projectId, userId, role, grantedBy ?? null]);
    },

    async removeMember(projectId: string, userId: string): Promise<boolean> {
      const { rows } = await db.query<{ user_id: string }>(
        `delete from project_members where project_id=$1 and user_id=$2 returning user_id`,
        [projectId, userId]);
      return rows.length > 0;
    },

    async listMembers(projectId: string) {
      const { rows } = await db.query(
        `select m.user_id, m.role, m.granted_at, u.email, u.name
           from project_members m join users u on u.id = m.user_id
          where m.project_id=$1 order by u.email`, [projectId]);
      return rows;
    },

    /**
     * The role `user` effectively holds on `projectId`, combining their global
     * role with any membership. Null means no access — which every caller must
     * treat as "this project does not exist", never as "you may not", because
     * the second answer confirms it does.
     */
    async projectRole(user: UserRow, projectId: string): Promise<ProjectRole | null> {
      const { rows } = await db.query<{ role: string }>(
        `select role from project_members where project_id=$1 and user_id=$2`, [projectId, user.id]);
      const membership = (rows[0]?.role ?? null) as ProjectRole | null;
      return effectiveProjectRole(user.role, membership);
    },

    // ----------------------------------------------------- installations

    async registerInstallation(input: {
      companyId: string; userId?: string | null; machineId: string;
      hostname?: string | null; os?: string | null; pluginVersion?: string | null;
    }): Promise<InstallationRow> {
      const { rows } = await db.query<InstallationRow>(
        `insert into installations (id, company_id, user_id, machine_id, hostname, os, plugin_version, last_seen_at)
         values ($1,$2,$3,$4,$5,$6,$7, now())
         on conflict (company_id, machine_id) do update
           set user_id = excluded.user_id, hostname = excluded.hostname,
               os = excluded.os, plugin_version = excluded.plugin_version,
               last_seen_at = now(), revoked_at = null
         returning *`,
        [newId(), input.companyId, input.userId ?? null, input.machineId,
         input.hostname ?? null, input.os ?? null, input.pluginVersion ?? null]);
      return rows[0];
    },

    async heartbeat(id: string): Promise<void> {
      await db.query(`update installations set last_seen_at=now() where id=$1`, [id]);
    },

    async listInstallations(companyId: string): Promise<InstallationRow[]> {
      const { rows } = await db.query<InstallationRow>(
        `select * from installations where company_id=$1 order by last_seen_at desc nulls last`, [companyId]);
      return rows;
    },

    async revokeInstallation(id: string): Promise<boolean> {
      const { rows } = await db.query<{ id: string }>(
        `update installations set revoked_at=now() where id=$1 and revoked_at is null returning id`, [id]);
      return rows.length > 0;
    },

    // ------------------------------------------------------------ audit

    async recordAction(input: {
      companyId: string; verb: string; projectId?: string | null; featureId?: string | null;
      issueId?: string | null; userId?: string | null; agentKey?: string | null;
      installationId?: string | null; targetType?: string | null; targetId?: string | null;
      detail?: Record<string, unknown>;
    }): Promise<void> {
      // Best-effort by design, exactly like the engine's own narration: an
      // audit insert that throws must not fail the operation it describes.
      try {
        await db.query(
          `insert into actions (id, company_id, project_id, feature_id, issue_id, user_id,
                                agent_key, installation_id, verb, target_type, target_id, detail)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
          [newId(), input.companyId, input.projectId ?? null, input.featureId ?? null,
           input.issueId ?? null, input.userId ?? null, input.agentKey ?? null,
           input.installationId ?? null, input.verb, input.targetType ?? null,
           input.targetId ?? null, JSON.stringify(input.detail ?? {})]);
      } catch (err) {
        console.error(`[platform] could not record action '${input.verb}':`, err);
      }
    },

    async listActions(companyId: string, filter: { projectId?: string; limit?: number } = {}):
      Promise<ActionRow[]> {
      const params: unknown[] = [companyId];
      let sql = `select * from actions where company_id=$1`;
      if (filter.projectId) { params.push(filter.projectId); sql += ` and project_id=$${params.length}`; }
      params.push(Math.min(filter.limit ?? 200, 1000));
      sql += ` order by created_at desc limit $${params.length}`;
      const { rows } = await db.query<ActionRow>(sql, params);
      return rows.map(r => ({ ...r, detail: asJson(r.detail) }));
    },

    // ------------------------------------------------------------ chats

    async createConversation(input: {
      companyId: string; userId?: string | null; projectId?: string | null;
      featureId?: string | null; title?: string | null;
    }): Promise<ConversationRow> {
      const { rows } = await db.query<ConversationRow>(
        `insert into conversations (id, company_id, user_id, project_id, feature_id, title)
         values ($1,$2,$3,$4,$5,$6) returning *`,
        [newId(), input.companyId, input.userId ?? null, input.projectId ?? null,
         input.featureId ?? null, input.title ?? null]);
      return rows[0];
    },

    async listConversations(companyId: string, filter: { userId?: string; projectId?: string } = {}) {
      const params: unknown[] = [companyId];
      let sql = `select * from conversations where company_id=$1`;
      if (filter.userId) { params.push(filter.userId); sql += ` and user_id=$${params.length}`; }
      if (filter.projectId) { params.push(filter.projectId); sql += ` and project_id=$${params.length}`; }
      const { rows } = await db.query<ConversationRow>(sql + ` order by updated_at desc limit 100`, params);
      return rows;
    },

    /**
     * Append a message. `seq` is allocated from the conversation's own high
     * water mark rather than from a global counter, so two conversations
     * cannot interleave — and the unique index makes a lost update visible as
     * a conflict rather than as a silently reordered chat.
     */
    async appendMessage(conversationId: string, input: {
      role: string; content: unknown; adapter?: string | null; model?: string | null;
      inputTokens?: number | null; outputTokens?: number | null; costUsd?: number | null;
    }): Promise<MessageRow> {
      const { rows: max } = await db.query<{ next: number }>(
        `select coalesce(max(seq),0) + 1 as next from messages where conversation_id=$1`, [conversationId]);
      const { rows } = await db.query<MessageRow>(
        `insert into messages (id, conversation_id, seq, role, content, adapter, model,
                               input_tokens, output_tokens, cost_usd)
         values ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10) returning *`,
        [newId(), conversationId, max[0].next, input.role, JSON.stringify(input.content),
         input.adapter ?? null, input.model ?? null, input.inputTokens ?? null,
         input.outputTokens ?? null, input.costUsd ?? null]);
      await db.query(`update conversations set updated_at=now() where id=$1`, [conversationId]);
      return rows[0];
    },

    async listMessages(conversationId: string): Promise<MessageRow[]> {
      const { rows } = await db.query<MessageRow>(
        `select * from messages where conversation_id=$1 order by seq`, [conversationId]);
      return rows.map(r => ({ ...r, content: typeof r.content === "string" ? JSON.parse(r.content) : r.content }));
    },

    // ------------------------------------------------------- run events

    /**
     * Append run log envelopes. Batched, because a talkative agent emits
     * thousands and a round trip each would dominate the run.
     */
    async appendRunEvents(runId: string, events: { stream: string; chunk: string; ts?: string }[]):
      Promise<number> {
      if (!events.length) return 0;
      const { rows: max } = await db.query<{ next: number }>(
        `select coalesce(max(seq),0) + 1 as next from run_events where run_id=$1`, [runId]);
      let seq = Number(max[0].next);

      const values: string[] = []; const params: unknown[] = [];
      for (const e of events) {
        params.push(runId, seq++, e.stream, e.chunk);
        const n = params.length;
        values.push(`($${n - 3},$${n - 2},$${n - 1},$${n})`);
      }
      await db.query(
        `insert into run_events (run_id, seq, stream, chunk) values ${values.join(",")}
         on conflict (run_id, seq) do nothing`, params);
      return events.length;
    },

    /** The run's log, reassembled in order — the file's replacement, byte for byte. */
    async readRunLog(runId: string, fromSeq = 0): Promise<{ text: string; nextSeq: number }> {
      const { rows } = await db.query<{ seq: number; chunk: string }>(
        `select seq, chunk from run_events where run_id=$1 and seq > $2 order by seq`, [runId, fromSeq]);
      return {
        text: rows.map(r => r.chunk).join(""),
        nextSeq: rows.length ? Number(rows[rows.length - 1].seq) : fromSeq,
      };
    },

    // ------------------------------------------------------------ spend

    /**
     * Cost, grouped. Before `issues.project_id` existed the only honest answer
     * was a company total: project lived inside `issues.params` jsonb, which
     * cannot be grouped on without parsing every row.
     */
    async spend(companyId: string, by: "project" | "agent" | "adapter" = "project"): Promise<SpendRow[]> {
      const dimension = {
        project: `p.id, p.name`,
        agent: `a.key`,
        adapter: `r.adapter`,
      }[by];
      const select = {
        project: `p.id as project_id, p.name as project_name, null::text as agent_key, null::text as adapter, null::uuid as user_id`,
        agent: `null::uuid as project_id, null::text as project_name, a.key as agent_key, null::text as adapter, null::uuid as user_id`,
        adapter: `null::uuid as project_id, null::text as project_name, null::text as agent_key, r.adapter as adapter, null::uuid as user_id`,
      }[by];

      const { rows } = await db.query<SpendRow>(
        `select ${select},
                count(r.id)::text as run_count,
                coalesce(sum(r.input_tokens),0)::text  as input_tokens,
                coalesce(sum(r.output_tokens),0)::text as output_tokens,
                coalesce(sum(r.cost_usd),0)::text      as cost_usd
           from runs r
           join issues i on i.id = r.issue_id
           left join projects p on p.id = i.project_id
           left join agents a on a.id = r.agent_id
          where i.company_id = $1
          group by ${dimension}
          order by 8 desc`,
        [companyId]);
      return rows;
    },
  };
}

export type PlatformRepo = ReturnType<typeof createPlatformRepo>;
export { tokenPrefix };
