CREATE TABLE "right_hand_seats" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"removed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "machine_tasks" ADD COLUMN "scope_id" uuid;--> statement-breakpoint
ALTER TABLE "right_hand_seats" ADD CONSTRAINT "right_hand_seats_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "right_hand_seats_one_live" ON "right_hand_seats" USING btree ("org_id","user_id") WHERE "right_hand_seats"."removed_at" is null;--> statement-breakpoint
INSERT INTO "agent_scopes" ("id", "org_id", "agent_id", "connection_id", "scope")
SELECT gen_random_uuid(), a."org_id", a."id", NULL, s."scope"
FROM "agents" a CROSS JOIN (VALUES ('sandbox:run'), ('browser:use'), ('desktop:use')) AS s("scope")
WHERE a."builtin" = 'right_hand'
ON CONFLICT DO NOTHING;
