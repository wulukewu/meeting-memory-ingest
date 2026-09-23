import type { Env, ManifestEntry } from "./types";
import { createResolverJobTicket, deleteResolverJobTicket, resolverWorkerUrl } from "./resolver-job";
import { truncate } from "./util";

export async function dispatchYouTubeResolver(env: Env, videoId: string, entry: ManifestEntry): Promise<void> {
  const owner = encodeURIComponent(env.RESOLVER_GITHUB_OWNER);
  const repo = encodeURIComponent(env.RESOLVER_GITHUB_REPO);
  const workflow = encodeURIComponent(env.RESOLVER_GITHUB_WORKFLOW);
  const ticket = await createResolverJobTicket(env, videoId, entry);

  const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/actions/workflows/${workflow}/dispatches`, {
    method: "POST",
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${env.RESOLVER_GITHUB_TOKEN}`,
      "content-type": "application/json",
      "user-agent": "meeting-memory-ingest",
      "x-github-api-version": "2022-11-28",
    },
    body: JSON.stringify({
      ref: "main",
      inputs: {
        resolver_job_token: ticket.token,
        worker_url: resolverWorkerUrl(env),
      },
    }),
  });

  if (!response.ok) {
    await deleteResolverJobTicket(env, ticket.token);
    throw new Error(`GitHub resolver dispatch failed (${response.status}): ${truncate(await response.text(), 800)}`);
  }
}
