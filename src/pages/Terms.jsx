import React from 'react'
import { Link } from 'react-router-dom'
import BluejackLogo from '../components/BluejackLogo'
import BadgerBoardLogo from '../components/BadgerBoardLogo'

const EFFECTIVE_DATE = 'March 19, 2026'

function Section({ title, children }) {
  return (
    <section className="mb-8">
      <h2 className="text-base font-bold text-gray-900 mb-3 pb-2 border-b border-gray-200">{title}</h2>
      <div className="text-sm text-gray-600 space-y-3 leading-relaxed">{children}</div>
    </section>
  )
}

export default function Terms() {
  return (
    <div className="min-h-screen bg-gray-50 flex flex-col">
      {/* Top stripe */}
      <div className="flex h-1.5">
        <div className="flex-1 bg-brand-red" />
        <div className="flex-1 bg-white" />
        <div className="flex-1 bg-blue-600" />
      </div>

      {/* Header */}
      <header className="bg-brand-navy px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-4">
          <BluejackLogo width={80} />
          <div className="border-l border-white/20 pl-4">
            <BadgerBoardLogo width={100} />
          </div>
        </div>
        <Link to="/login" className="text-white/60 hover:text-white text-sm transition-colors">
          ← Back to sign in
        </Link>
      </header>

      {/* Content */}
      <main className="flex-1 max-w-3xl mx-auto w-full px-6 py-12">
        <div className="bg-white rounded-2xl shadow-sm border border-gray-200 p-8 lg:p-12">

          {/* Title block */}
          <div className="mb-10 pb-6 border-b border-gray-200">
            <h1 className="text-2xl font-bold text-gray-900 mb-2">Terms of Service</h1>
            <p className="text-sm text-gray-500">
              Badger Board — Wisconsin Political Intelligence Platform<br />
              Operated by <strong className="text-gray-700">The Bluejack Group</strong><br />
              Effective Date: <strong className="text-gray-700">{EFFECTIVE_DATE}</strong>
            </p>
          </div>

          {/* Preamble */}
          <p className="text-sm text-gray-600 leading-relaxed mb-8">
            These Terms of Service ("Terms") govern your access to and use of the Badger Board platform and related services (collectively, the "Service") operated by The Bluejack Group ("Company," "we," "us," or "our"). By creating an account or using the Service, you agree to be bound by these Terms. If you do not agree, do not access or use the Service.
          </p>

          <Section title="1. Acceptance of Terms">
            <p>
              By registering for an account, accessing the Service, or clicking "I agree" on the account creation form, you acknowledge that you have read, understood, and agree to be legally bound by these Terms and our Privacy Policy, which is incorporated herein by reference.
            </p>
            <p>
              If you are using the Service on behalf of an organization or business entity, you represent and warrant that you have the authority to bind that entity to these Terms, and references to "you" shall include both you individually and that entity.
            </p>
          </Section>

          <Section title="2. Description of Service">
            <p>
              Badger Board is a subscription-based political intelligence platform providing AI-generated research profiles, candidate discovery tools, campaign intelligence briefings, and outreach prospecting tools focused on Wisconsin political activity. The Service is intended for use by political professionals, campaigns, party organizations, political consultants, and related organizations.
            </p>
            <p>
              All AI-generated content is for informational and research purposes only. We make no representations or warranties as to the accuracy, completeness, or timeliness of AI-generated reports. Users are solely responsible for verifying all information before relying upon it for any purpose.
            </p>
          </Section>

          <Section title="3. Account Registration and Eligibility">
            <p>
              To access the Service, you must create an account by providing accurate, complete, and current information, including your legal name, business or organization, professional role, contact information, and email address. You agree to maintain the accuracy of this information and to update it promptly if it changes.
            </p>
            <p>
              You must be at least 18 years of age to use the Service. By creating an account, you represent that you meet this requirement. Accounts may not be shared, transferred, or used by more than one individual unless the Company has expressly authorized otherwise in writing.
            </p>
            <p>
              You are responsible for maintaining the confidentiality of your account credentials. You agree to notify us immediately at <strong>support@thebluejackgroup.com</strong> if you suspect any unauthorized use of your account.
            </p>
          </Section>

          <Section title="4. Subscription Plans and Billing">
            <p>
              Access to certain features of the Service requires a paid subscription. Subscription tiers, pricing, and included features are described on the platform's Settings page and are subject to change upon reasonable notice. All fees are stated in U.S. Dollars and are non-refundable except as required by applicable law or expressly stated in these Terms.
            </p>
            <p>
              Subscriptions automatically renew on a monthly basis unless cancelled before the renewal date. You authorize us to charge your payment method on file at the beginning of each billing cycle. Failure to pay may result in suspension or termination of your account.
            </p>
            <p>
              Billing is processed through Stripe, Inc. Your payment information is transmitted directly to and stored by Stripe and is subject to Stripe's privacy policy and terms of service. The Company does not store payment card data.
            </p>
          </Section>

          <Section title="5. Acceptable Use">
            <p>You agree to use the Service only for lawful purposes and in accordance with these Terms. You agree not to:</p>
            <ul className="list-disc ml-5 space-y-1.5">
              <li>Use the Service to harass, defame, or harm any individual or group;</li>
              <li>Use AI-generated content without independent verification for any public-facing or legally consequential purpose;</li>
              <li>Attempt to access, probe, or test the vulnerability of any system or network connected to the Service;</li>
              <li>Reverse-engineer, decompile, or otherwise attempt to derive source code from the Service;</li>
              <li>Use the Service in any manner that could disable, overburden, or impair the platform;</li>
              <li>Share your account credentials with unauthorized parties;</li>
              <li>Use the Service in violation of any applicable federal, state, or local law, including Wisconsin campaign finance law and the Federal Election Campaign Act;</li>
              <li>Reproduce, distribute, or resell AI-generated reports without the prior written consent of the Company.</li>
            </ul>
          </Section>

          <Section title="6. Intellectual Property">
            <p>
              The Service, including its software, design, text, graphics, logos, and the Badger Board name, are the exclusive property of The Bluejack Group and are protected by copyright, trademark, and other intellectual property laws. Nothing in these Terms grants you any right, title, or interest in the Service or Company's intellectual property other than a limited, non-exclusive, non-transferable license to access and use the Service for your internal business purposes during the term of your subscription.
            </p>
            <p>
              AI-generated profiles and reports produced through your use of the Service are licensed to you for internal use. You may not resell, sublicense, or publicly distribute such reports without prior written authorization.
            </p>
          </Section>

          <Section title="7. Privacy and Data Use">
            <p>
              We collect, process, and store information about you and your use of the Service in accordance with our Privacy Policy. By using the Service, you consent to such collection and processing. We implement industry-standard security measures including HTTPS encryption, row-level database security, and authentication controls. However, no transmission over the Internet is completely secure, and we cannot guarantee the absolute security of your data.
            </p>
            <p>
              We do not sell your personal information to third parties. Information you provide at registration (name, business, role, phone, email) is used solely to operate and improve the Service, communicate with you about your account, and as required by law.
            </p>
          </Section>

          <Section title="8. Disclaimers and Limitation of Liability">
            <p>
              THE SERVICE IS PROVIDED "AS IS" AND "AS AVAILABLE" WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, OR NON-INFRINGEMENT. THE COMPANY DOES NOT WARRANT THAT THE SERVICE WILL BE UNINTERRUPTED, ERROR-FREE, OR THAT AI-GENERATED CONTENT WILL BE ACCURATE OR COMPLETE.
            </p>
            <p>
              TO THE FULLEST EXTENT PERMITTED BY APPLICABLE LAW, THE COMPANY SHALL NOT BE LIABLE FOR ANY INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL, OR PUNITIVE DAMAGES, INCLUDING LOST PROFITS, DATA LOSS, OR REPUTATIONAL HARM, ARISING FROM YOUR USE OF OR INABILITY TO USE THE SERVICE, EVEN IF THE COMPANY HAS BEEN ADVISED OF THE POSSIBILITY OF SUCH DAMAGES.
            </p>
            <p>
              IN NO EVENT SHALL THE COMPANY'S TOTAL LIABILITY TO YOU FOR ALL CLAIMS ARISING FROM OR RELATED TO THESE TERMS OR YOUR USE OF THE SERVICE EXCEED THE GREATER OF (A) THE TOTAL AMOUNTS PAID BY YOU TO THE COMPANY IN THE TWELVE (12) MONTHS PRECEDING THE CLAIM OR (B) ONE HUNDRED DOLLARS ($100.00).
            </p>
          </Section>

          <Section title="9. Indemnification">
            <p>
              You agree to defend, indemnify, and hold harmless The Bluejack Group and its officers, directors, employees, agents, and contractors from and against any claims, liabilities, damages, losses, and expenses, including reasonable attorneys' fees, arising from or related to: (a) your use of the Service; (b) your violation of these Terms; (c) your violation of any law or third-party right; or (d) any content or information you submit to the Service.
            </p>
          </Section>

          <Section title="10. Termination">
            <p>
              Either party may terminate your account and access to the Service at any time. You may cancel your subscription through the billing portal within the Service. The Company reserves the right to suspend or terminate your account immediately, without notice, if we determine in our sole discretion that you have violated these Terms, engaged in fraudulent activity, or your use poses a risk to the Service or other users.
            </p>
            <p>
              Upon termination, your right to use the Service ceases immediately. Provisions of these Terms that by their nature should survive termination shall survive, including Sections 6, 7, 8, 9, 11, and 12.
            </p>
          </Section>

          <Section title="11. Governing Law and Jurisdiction">
            <p>
              These Terms and any dispute arising out of or relating to these Terms or your use of the Service shall be governed by and construed in accordance with the laws of the State of Wisconsin, without regard to its conflict of law provisions.
            </p>
            <p>
              Any legal action or proceeding relating to these Terms shall be brought exclusively in the state or federal courts located in <strong>Marathon County, Wisconsin, United States</strong>. You hereby consent to the personal jurisdiction and venue of such courts and waive any objection to the laying of venue in such courts.
            </p>
          </Section>

          <Section title="12. Severability">
            <p>
              If any provision of these Terms is found by a court of competent jurisdiction to be invalid, unlawful, void, or unenforceable for any reason, that provision shall be deemed modified to the minimum extent necessary to make it enforceable, or if modification is not possible, it shall be severed from these Terms. The invalidity or unenforceability of any provision shall not affect the validity or enforceability of any other provision of these Terms, and all remaining provisions shall continue in full force and effect as if the invalid or unenforceable provision had never been included.
            </p>
          </Section>

          <Section title="13. Changes to These Terms">
            <p>
              We reserve the right to modify these Terms at any time. If we make material changes, we will notify you by email or by posting a prominent notice within the Service at least fourteen (14) days before the changes take effect. Your continued use of the Service after the effective date of revised Terms constitutes your acceptance of the changes.
            </p>
          </Section>

          <Section title="14. Contact Information">
            <p>
              For questions about these Terms, please contact:
            </p>
            <div className="mt-2 p-4 bg-gray-50 rounded-xl text-sm text-gray-700 space-y-1">
              <p className="font-semibold text-gray-900">The Bluejack Group</p>
              <p>Wausau, Marathon County, Wisconsin</p>
              <p>Email: <a href="mailto:support@thebluejackgroup.com" className="text-brand-red underline underline-offset-2">support@thebluejackgroup.com</a></p>
              <p>Website: <a href="https://www.thebluejackgroup.com" target="_blank" rel="noopener noreferrer" className="text-brand-red underline underline-offset-2">www.thebluejackgroup.com</a></p>
            </div>
          </Section>

          {/* Footer rule */}
          <div className="mt-10 pt-6 border-t border-gray-200 text-xs text-gray-400 text-center space-y-1">
            <p>© {new Date().getFullYear()} The Bluejack Group. All rights reserved.</p>
            <p>Badger Board · Wisconsin Political Intelligence Platform</p>
            <p className="mt-2">
              <Link to="/login" className="text-brand-red hover:opacity-80 underline underline-offset-2">
                Return to sign in
              </Link>
            </p>
          </div>
        </div>
      </main>
    </div>
  )
}
