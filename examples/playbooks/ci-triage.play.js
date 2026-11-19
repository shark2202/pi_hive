export const meta = {
  name: "ci-triage",
  description: "One worker per failing CI job; update the tracker as it goes",
  concurrency: 2,
};

export async function run(ctx) {
  const result = await ctx.converge({
    pending: () => ctx.trackerQuery(
      "SELECT id, job FROM ci_failures WHERE status='open'"
    ),
    dispatch: async (row) => {
      const r = await ctx.worker(`Reproduce and fix CI job: ${row.job}`, {
        data: row,
        goal: `Fixing CI job ${row.job}`,
      });
      if (r.status === "done") {
        ctx.trackerExec(
          `UPDATE ci_failures SET status='done' WHERE id='${row.id}'`
        );
      }
      return r;
    },
    maxRounds: 3,
    circuitBreaker: 0.5,
  });
  ctx.log(`remaining=${result.remaining}`);
  return result;
}
