-- IF NOT EXISTS, by hand: a plain CREATE INDEX holds every write to its table while it builds, and a migration's
-- transaction can't run CREATE INDEX CONCURRENTLY. An instance whose tables are large may build these beforehand,
-- concurrently and under these names, and this migration then finds them.
CREATE INDEX IF NOT EXISTS "agent_questions_org_id_created_at_index" ON "agent_questions" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_run_steps_tool_calls_idx" ON "agent_run_steps" USING btree ("org_id","created_at") WHERE "agent_run_steps"."kind" = 'tool_call';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "outbox_created_idx" ON "outbox" USING btree ("created_at","id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "outbox_run_jobs_idx" ON "outbox" USING btree ("dedupe_key" text_pattern_ops) WHERE "outbox"."kind" = 'agent_run.execute';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "secret_requests_org_id_created_at_index" ON "secret_requests" USING btree ("org_id","created_at");