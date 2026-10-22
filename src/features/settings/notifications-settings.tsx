"use client";

import { BellRing } from "lucide-react";
import { useState } from "react";
import { Toggle } from "@/components/ui/form";
import { Card, CardHeader } from "@/components/ui/misc";
import { NOTIFICATION_GROUPS, type NotificationEvent } from "@/domain/notifications";
import type { Role, Settings } from "@/domain/types";
import { useRunAction } from "@/lib/run-action";
import { useWorkspace } from "@/lib/workspace";
import { setNotificationRule, updateSettings } from "@/server/actions";
import { NumberSetting } from "./settings-page";

const WHO: Record<Role, string> = { sales: "Sales agents", support: "Customer support", manager: "Managers", accountant: "Accountants" };

/** Settings → Notifications: what each role is told, whether it pops up with a sound, and timing. */
export function NotificationsSettings() {
  const { ref } = useWorkspace();
  const runAction = useRunAction();
  const s = ref.settings;
  const save = (patch: Partial<Settings>) => runAction(updateSettings(patch), "Setting saved", { reference: true });

  return (
    <div className="space-y-5">
      <Card>
        <CardHeader title="Timing" subtitle="When the timed notifications are sent. The scheduler checks every 2 minutes." />
        <div className="divide-y divide-line">
          <NumberSetting
            label="Remind before a follow-up"
            hint="Reminder to the follow-up's owner this long before it is due. 0 sends it at the due time."
            value={s.reminderMinutesBefore}
            unit="minutes"
            onSave={(n) => save({ reminderMinutesBefore: n })}
          />
          <NumberSetting
            label="Alert when a new lead is not opened after"
            hint="Tells the agent (and managers, if switched on below) once. 0 turns the alert off."
            value={s.unopenedAlertMinutes}
            unit="minutes"
            onSave={(n) => save({ unopenedAlertMinutes: n })}
          />
          <NumberSetting
            label="Remind before a planned payment"
            hint="Payment due soon goes out this many days before the date (from 9:00). Overdue alerts follow the day after. 0 turns the reminder off."
            value={s.paymentDueSoonDays}
            unit="days"
            onSave={(n) => save({ paymentDueSoonDays: n })}
          />
        </div>
      </Card>

      <p className="flex items-start gap-2 rounded-xl border border-line bg-white px-4 py-3 text-sm text-muted">
        <BellRing size={16} className="mt-0.5 shrink-0 text-navy-700" aria-hidden />
        <span>
          Everything that is switched on appears in the bell list. With <b className="font-medium text-ink">Pop-up and sound</b>, it also pops up at the
          bottom of the screen with a short sound while the CRM is open. Each person can mute the sound or turn on desktop alerts from the bell.
        </span>
      </p>

      {NOTIFICATION_GROUPS.map((g) => (
        <Card key={g.title}>
          <CardHeader title={g.title} />
          <ul className="divide-y divide-line">
            {g.events.map((ev) => (
              <EventRow key={ev.key} event={ev} />
            ))}
          </ul>
        </Card>
      ))}
    </div>
  );
}

function EventRow({ event }: { event: NotificationEvent }) {
  return (
    <li className="flex flex-col gap-3 px-4 py-3 md:flex-row md:items-start md:justify-between">
      <div className="min-w-0 text-sm">
        <p className="font-medium">{event.label}</p>
        <p className="text-xs text-muted">{event.description}</p>
      </div>
      <div className="flex flex-wrap gap-2 md:justify-end">
        {event.roles.map((role) => (
          <RuleCard key={role} event={event} role={role} />
        ))}
      </div>
    </li>
  );
}

type RuleValue = { enabled: boolean; popup: boolean };

function RuleCard({ event, role }: { event: NotificationEvent; role: Role }) {
  const { ref } = useWorkspace();
  const runAction = useRunAction();
  const saved: RuleValue = ref.notificationRules.find((r) => r.event === event.key && r.role === role) ?? { enabled: true, popup: false };
  // Shows the change at once; goes back if saving fails. Dropped once the saved value matches.
  const [pending, setPending] = useState<RuleValue | null>(null);
  if (pending && pending.enabled === saved.enabled && pending.popup === saved.popup) setPending(null);
  const rule = pending ?? saved;
  const who = WHO[role];

  const set = async (next: RuleValue, msg: string) => {
    setPending(next);
    const r = await runAction(setNotificationRule(event.key, role, next.enabled, next.popup), msg, { reference: true });
    if (!r.ok) setPending(null);
  };

  return (
    <div data-rule={`${event.key}:${role}`} className="w-[196px] rounded-lg border border-line px-3 py-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-muted">{who}</span>
        <Toggle
          label={`${event.label}: notify ${who.toLowerCase()}`}
          checked={rule.enabled}
          onChange={(v) => set({ ...rule, enabled: v }, v ? `${who} will be notified` : `${who} will not be notified`)}
        />
      </div>
      <label className={`mt-1.5 flex items-center gap-2 text-xs ${rule.enabled ? "" : "text-muted"}`}>
        <input
          type="checkbox"
          className="h-4 w-4 accent-[var(--color-navy-900)]"
          checked={rule.enabled && rule.popup}
          disabled={!rule.enabled}
          onChange={(e) => set({ ...rule, popup: e.target.checked }, e.target.checked ? "Pop-up and sound on" : "Pop-up and sound off")}
          aria-label={`${event.label}: pop-up and sound for ${who.toLowerCase()}`}
        />
        Pop-up and sound
      </label>
    </div>
  );
}
