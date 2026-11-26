import { pool } from "./db/pool.js";
import { config } from "./config.js";

export async function generateCurrentMonthDues() {
  const result = await pool.query(
    `WITH due_month AS (
       SELECT date_trunc('month',CURRENT_DATE)::date AS month,
              (date_trunc('month',CURRENT_DATE)::date +
                (LEAST($1::int, extract(day FROM (date_trunc('month',CURRENT_DATE) + interval '1 month' - interval '1 day'))::int)-1))::date AS due_date
     ), added AS (
       INSERT INTO rent_dues(property_id,resident_id,month,amount_cents,due_date)
       SELECT m.property_id,m.user_id,dm.month,m.monthly_rent_cents,dm.due_date
       FROM memberships m CROSS JOIN due_month dm
       WHERE m.role='RESIDENT' AND m.status='ACTIVE' AND m.monthly_rent_cents IS NOT NULL
       ON CONFLICT(resident_id,property_id,month) DO NOTHING
       RETURNING id,resident_id,property_id,month
     ), notices AS (
       INSERT INTO notifications(user_id,property_id,type,title,body,data)
       SELECT resident_id,property_id,'RENT_DUE','Rent due created',
         'Your rent for '||to_char(month,'FMMonth YYYY')||' is ready',jsonb_build_object('rentDueId',id)
       FROM added RETURNING id
     ) SELECT count(*)::int AS created FROM added`,
    [config.RENT_DUE_DAY]
  );
  return result.rows[0].created;
}

export function startRentScheduler() {
  let running = false;
  let stopped = false;
  let timer;
  const run = async () => {
    if (running || stopped) return;
    running = true;
    let failed = false;
    try {
      const created = await generateCurrentMonthDues();
      if (created)
        console.info(`Generated ${created} rent dues for the current month`);
    } catch (error) {
      failed = true;
      console.error("Monthly rent due generation failed", error);
    } finally {
      running = false;
      if (!stopped) {
        timer = setTimeout(run, failed ? 5 * 60 * 1000 : 24 * 60 * 60 * 1000);
        timer.unref();
      }
    }
  };
  void run();
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}
