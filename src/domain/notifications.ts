import type { Role } from "./types";

/**
 * The notification types managers can switch on and off (Settings → Notifications).
 * Keys match public.notification_rules.event and notifications.kind in the database.
 */
export interface NotificationEvent {
  key: string;
  label: string;
  description: string;
  roles: Role[];
}

export const NOTIFICATION_GROUPS: { title: string; events: NotificationEvent[] }[] = [
  {
    title: "Leads",
    events: [
      { key: "lead_assigned", label: "New lead assigned", description: "A lead is given to the agent, by the turn order or by a manager.", roles: ["sales"] },
      { key: "returning_customer", label: "Returning customer", description: "A customer who had a lead with this agent before comes back.", roles: ["sales"] },
      { key: "form_resubmitted", label: "Form submitted again", description: "One of the agent's customers fills in the form again.", roles: ["sales"] },
      { key: "lead_not_opened", label: "Lead not opened yet", description: "Reminder to the agent when an assigned lead has not been opened in time.", roles: ["sales"] },
      { key: "new_lead", label: "Every new lead", description: "Each new lead that comes in, from the Google Sheets or added by hand.", roles: ["manager"] },
      { key: "lead_not_opened_manager", label: "Lead not opened in time", description: "An agent has not opened an assigned lead in time.", roles: ["manager"] },
      { key: "no_agent_on_shift", label: "Leads waiting, nobody on shift", description: "Leads are waiting because no sales agent is on shift for that program (at most hourly).", roles: ["manager"] },
      { key: "previous_agent_inactive", label: "Returning customer's agent has left", description: "A returning customer's previous agent is no longer active, so the lead went to the turn order.", roles: ["manager"] },
    ],
  },
  {
    title: "Follow-ups",
    events: [
      { key: "followup_due", label: "Follow-up reminder", description: "Before a follow-up is due (the time is set under Timing, at the top).", roles: ["sales", "support"] },
    ],
  },
  {
    title: "Payments and support",
    events: [
      { key: "payment_to_review", label: "Payment to review", description: "An agent submitted a payment receipt.", roles: ["manager"] },
      { key: "payment_update", label: "Payment confirmed, rejected or reversed", description: "A decision on a payment the person submitted.", roles: ["sales", "support"] },
      { key: "handed_over", label: "Customer handed over to support", description: "The agent's customer enrolled and moved to support.", roles: ["sales"] },
      { key: "new_customer_ready", label: "New customer ready for onboarding", description: "A newly enrolled customer is waiting for support.", roles: ["support"] },
      { key: "support_assigned", label: "Customer assigned for onboarding", description: "A customer is given to this support agent.", roles: ["support"] },
      { key: "customer_flagged", label: "Customer flagged after a payment reversal", description: "A handed-over customer's confirmed payments fell below the handover rule.", roles: ["support", "manager"] },
    ],
  },
  {
    title: "System",
    events: [
      { key: "sheet_problem", label: "Google Sheets problem", description: "A sheet needs attention or Google needs to be reconnected.", roles: ["manager"] },
    ],
  },
];

export const NOTIFICATION_ROLES: Role[] = ["sales", "support", "manager"];
