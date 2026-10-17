import Link from "next/link";

export const metadata = { title: "Privacy policy · Ammar Academy CRM" };

const CONTACT = "adelamar888@gmail.com";
const UPDATED = "17 October 2026";

/** Public page: Google requires a privacy policy for apps that use Google sign-in. */
export default function PrivacyPage() {
  return (
    <main className="min-h-dvh bg-canvas px-4 py-10">
      <article className="mx-auto max-w-2xl rounded-[var(--radius-card)] border border-line bg-white p-6 text-[15px] leading-relaxed sm:p-10">
        <p className="text-xs font-medium uppercase tracking-[0.14em] text-orange-600">Ammar Academy CRM</p>
        <h1 className="mt-1 text-2xl font-semibold">Privacy policy</h1>
        <p className="mt-1 text-sm text-muted">Last updated {UPDATED}</p>

        <Section title="Who we are">
          <p>
            Ammar Academy CRM is the internal customer-management system of Ammar Academy, an online test-preparation academy. It is used only by
            Ammar Academy staff. There is no public sign-up; accounts are created by a manager. Contact: <a className="text-navy-700 underline" href={`mailto:${CONTACT}`}>{CONTACT}</a>.
          </p>
        </Section>

        <Section title="What information the CRM holds">
          <ul className="list-disc space-y-1 pl-5">
            <li><strong>Staff accounts:</strong> name, work email, role and sign-in records.</li>
            <li><strong>Student inquiries:</strong> the details a student or parent gives Ammar Academy (for example name, phone number, grade, school, target score and exam date), plus notes, follow-ups, enrollments and payment records added by staff.</li>
            <li><strong>Payment receipts</strong> uploaded by staff, kept in private storage.</li>
          </ul>
          <p>This information is used only to answer inquiries, enroll students and support them. It is never sold and never used for advertising.</p>
        </Section>

        <Section title="Google account data">
          <p>A manager can connect a Google account so that new rows in the Academy&apos;s lead spreadsheets arrive in the CRM automatically. When connecting, the CRM asks Google for:</p>
          <ul className="list-disc space-y-1 pl-5">
            <li><strong>Your email address</strong> (<code>openid</code>, <code>userinfo.email</code>), to show which Google account is connected.</li>
            <li><strong>Access to the specific files you choose</strong> (<code>drive.file</code>). The CRM can open only the spreadsheets the manager picks in Google&apos;s file picker. It cannot see any other file in Google Drive.</li>
          </ul>
          <p>
            The CRM only <strong>reads</strong> the chosen spreadsheets, to import new rows as inquiries. It never edits or deletes them. The Google sign-in token is
            encrypted (AES-256-GCM) before it is stored, and only the CRM server can use it.
          </p>
          <p>
            Google user data is used only to provide this import feature. It is not shared with anyone, not transferred to third parties, not used for advertising,
            and not used to train AI or machine-learning models. Ammar Academy CRM&apos;s use and transfer of information received from Google APIs adheres to the{" "}
            <a className="text-navy-700 underline" href="https://developers.google.com/terms/api-services-user-data-policy" rel="noreferrer">Google API Services User Data Policy</a>,
            including the Limited Use requirements.
          </p>
          <p>
            To stop access at any time, a manager can click <strong>Disconnect</strong> in <em>Settings → Google Sheets Connections</em>, which deletes the stored token and
            asks Google to revoke it. Access can also be removed from your Google Account at{" "}
            <a className="text-navy-700 underline" href="https://myaccount.google.com/permissions" rel="noreferrer">myaccount.google.com/permissions</a>.
          </p>
        </Section>

        <Section title="Where data is kept and who can see it">
          <p>
            Data is stored with our hosting providers (Supabase for the database and files, DigitalOcean for the application), in data centres in Frankfurt, Germany,
            with encrypted connections. Each staff member sees only what their role allows; this is enforced in the database. Changes to settings, roles and payments are
            recorded in an audit history.
          </p>
        </Section>

        <Section title="How long we keep it, and your choices">
          <p>
            Inquiry and enrollment records are kept while they are needed to serve the student and for Ammar Academy&apos;s records. A student or parent can ask to see,
            correct or delete their information, or ask not to be contacted again, by writing to <a className="text-navy-700 underline" href={`mailto:${CONTACT}`}>{CONTACT}</a>.
          </p>
        </Section>

        <Section title="Changes">
          <p>If this policy changes, the new version will be posted on this page with a new date.</p>
        </Section>

        <p className="mt-8 border-t border-line pt-4 text-sm"><Link href="/login" className="text-navy-700 underline">Back to sign in</Link></p>
      </article>
    </main>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-6 space-y-2">
      <h2 className="text-lg font-semibold">{title}</h2>
      {children}
    </section>
  );
}
