-- deploy-safe: the index made below keeps one open handoff per agent and screen for rows without a seat, the only rows a previous version writes
DROP INDEX "browser_handoffs_one_open";--> statement-breakpoint
ALTER TABLE "browser_handoffs" ADD COLUMN "seat_user_id" text;--> statement-breakpoint
ALTER TABLE "browser_handoffs" ADD CONSTRAINT "browser_handoffs_seat_user_id_users_id_fk" FOREIGN KEY ("seat_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "browser_handoffs_one_open_screen" ON "browser_handoffs" USING btree ("agent_id","screen",coalesce("seat_user_id", '')) WHERE "browser_handoffs"."status" in ('pending', 'active');