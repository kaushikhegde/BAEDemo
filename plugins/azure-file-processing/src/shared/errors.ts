import { randomBytes } from "node:crypto";
import { log } from "./logger.js";

/**
 * Two kinds of failure, and the difference is WHO CAN ACT.
 *
 * This plugin is installed by end users. They have no checkout of this
 * repository, no `.env`, no shell on the machine serving the MCP planes, and no
 * way to start, stop or configure anything. Until this was written, a failure
 * told them otherwise: `npm run dev` from the repo root (three places), `set
 * SCYNE_ORCH_TOKEN` (two), `npm run sync:docs -- --apply` (one), and two sites
 * that spliced 300–400 characters of the server's own response body straight
 * into the conversation. Every one of those names a machine the reader does not
 * have.
 *
 * It is the same rule the workflow engine already follows for its timeline —
 * "an `exec` narrates its `label`, never its command", because that timeline is
 * what a CLIENT watches, and `running node scripts/render-companion-app.mjs
 * SAPN` tells them nothing they wanted while disclosing a path on our machine.
 *
 *   userError    the caller can fix it. A bad argument, a missing prerequisite,
 *                a gate that needs approving. The message is theirs and survives
 *                verbatim — `ambiguous_kind: … pass kind: sop | transcripts |
 *                notes | ui` is exactly what somebody needs to read.
 *
 *   serviceError the caller cannot. Unreachable service, refused credential,
 *                5xx, misconfiguration. They get one fixed sentence and a
 *                reference; the real cause is logged for whoever operates the
 *                install.
 *
 * The `code:` prefix survives on both, because the MODEL reads it: it is how a
 * tool result is told apart as "fix your argument and retry" from "stop". What
 * changed is the prose behind the colon, not the vocabulary in front of it.
 *
 * Deliberately NOT an Error subclass. These cross an MCP boundary that
 * serialises `err.message` and nothing else — a custom class buys a `name` and
 * an `instanceof` that no consumer here can see, and would tempt a caller into
 * attaching a `cause` field that gets serialised by accident. The message IS
 * the contract.
 */

/** Short, unambiguous, and safe to read down a phone. */
const reference = (): string => randomBytes(4).toString("hex");

/**
 * A failure the caller can act on. The message reaches them unchanged.
 *
 * Use this for anything the person typing could genuinely have done
 * differently: an argument that names nothing, a stage whose prerequisite has
 * not run, a document kind that cannot be inferred. Making these generic would
 * be a WORSE product, not a more discreet one — it removes the errors that are
 * actually useful and leaves the ones that are not.
 */
export const userError = (code: string, message: string): Error =>
  new Error(`${code}: ${message}`);

/**
 * A failure only an operator can act on. The caller gets a reference, not a
 * cause.
 *
 * `cause` is logged at error level against the same reference, so an operator
 * reading the log has everything the user's screen used to show. It is
 * TRUNCATED to fit the logger's field limit rather than being allowed to throw:
 * an error path that fails while reporting an error leaves no record at all,
 * which is the one outcome worse than a long line.
 *
 * `nothingChanged` defaults TRUE because that is the honest reading of almost
 * every site here — a fetch that never connected, a credential refused before
 * any write. Pass false where a write may have half-landed; "nothing was
 * changed" is a promise, and a wrong one sends somebody looking in the wrong
 * place.
 */
export const serviceError = (
  code: string,
  cause: unknown,
  opts: { nothingChanged?: boolean; context?: Record<string, string | number | boolean | null> } = {},
): Error => {
  const ref = reference();
  const detail = cause instanceof Error ? cause.message : String(cause ?? "");
  log.error("plugin.service_error", {
    ref, code,
    // 400 leaves room under the logger's 512-char ceiling for the rest of the
    // record, and is more of a server response than any of the old messages
    // showed a user anyway.
    cause: detail.slice(0, 400),
    ...(opts.context ?? {}),
  });
  return new Error(
    `${code}: Scyne could not complete that request.` +
    (opts.nothingChanged === false ? "" : " Nothing was changed.") +
    ` Quote reference ${ref} if you contact support.`,
  );
};

/**
 * The credential this plugin holds was refused.
 *
 * Split from `serviceError` only for its wording: it is still nothing the
 * caller can do anything about — the token belongs to the installation, not to
 * them — but "not signed in" and "temporarily unavailable" send an operator to
 * two different places, and the code is what the model branches on.
 */
export const authError = (cause: unknown, context?: Record<string, string | number | boolean | null>): Error =>
  serviceError("not_authenticated", cause, { context });
