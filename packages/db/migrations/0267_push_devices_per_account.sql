ALTER TABLE "push_devices" DROP CONSTRAINT "push_devices_token_unique";--> statement-breakpoint
CREATE UNIQUE INDEX "push_devices_user_id_token_index" ON "push_devices" USING btree ("user_id","token");--> statement-breakpoint
CREATE INDEX "push_devices_token_index" ON "push_devices" USING btree ("token");