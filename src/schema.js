/**
 * Single source of truth for the application form.
 *
 * The browser fetches this via GET /api/schema and renders the form from it;
 * the server validates every submission against the exact same definition.
 * Add a role or a question here and both sides pick it up — no duplicated logic.
 */

/**
 * Where the job physically is. Every role on this mandate is fully onsite.
 *
 * Three separate values on purpose: the full address is what a candidate needs
 * to judge a commute, the city is what reads correctly inside a question
 * ("I live in Gurugram"), and the region is what makes a daily commute
 * plausible from outside the city itself.
 */
export const OFFICE = {
  address: process.env.OFFICE_ADDRESS || 'Udyog Vihar Phase 2, Sector 20, Gurugram',
  city: process.env.OFFICE_CITY || 'Gurugram',
  region: process.env.OFFICE_REGION || 'Delhi NCR',
  get mapsUrl() {
    return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(this.address)}`;
  },
};

export const BRAND = {
  client: 'Hack Daily',
  clientUrl: 'https://hackdailylife.com/',
  agency: 'Rocket Recruiters',
  office: { address: OFFICE.address, city: OFFICE.city, region: OFFICE.region, mapsUrl: OFFICE.mapsUrl },
  workMode: 'Fully onsite',
};

/** Field types the renderer + validator both understand. */
export const FIELD_TYPES = [
  'text',
  'email',
  'tel',
  'url',
  'number',
  'select',
  'multiselect',
  'textarea',
];

const NOTICE_PERIODS = [
  'Immediate',
  '15 days',
  '30 days',
  '60 days',
  '90 days',
];

const SOURCES = [
  'LinkedIn',
  'Instagram',
  'Naukri',
  'Referral',
  'Rocket Recruiters reached out',
  'Hack Daily website',
  'Other',
];

/**
 * A knockout answer ends the application immediately with a plain explanation,
 * rather than letting someone complete 20 questions and upload a CV for a role
 * they cannot physically take.
 *
 * The three passing options are not cosmetic: a daily cross-NCR commute to
 * Udyog Vihar is a real attrition risk, so it is worth knowing at screening
 * time whether someone is local, commuting in, or moving.
 */
export const ONSITE_FIELD = {
  name: 'onsiteCommitment',
  label: `This role is onsite at our ${OFFICE.city} office, five days a week. Which is true for you?`,
  hint: `${OFFICE.address}. There is no remote or hybrid option, so we ask up front.`,
  type: 'select',
  required: true,
  options: [
    `I live in ${OFFICE.city} — short commute`,
    `I live elsewhere in ${OFFICE.region} and can commute daily`,
    `I am outside ${OFFICE.region} and will relocate for this role`,
    'I need remote or hybrid work',
  ],
  knockout: {
    value: 'I need remote or hybrid work',
    message:
      `Thanks for your interest — but every role on this mandate is onsite at ${OFFICE.address}, ` +
      'five days a week, with no remote or hybrid option. So we cannot take this further, and we ' +
      'have not stored your details. If your situation changes, apply again any time.',
  },
};

/** Asked of every candidate, whatever the role. */
export const COMMON_FIELDS = [
  { name: 'fullName', label: 'Full name', type: 'text', required: true, maxLength: 120, placeholder: 'As it appears on your CV' },
  { name: 'email', label: 'Email', type: 'email', required: true, maxLength: 160, placeholder: 'you@example.com' },
  { name: 'phone', label: 'Phone (WhatsApp)', type: 'tel', required: true, maxLength: 20, placeholder: '+91 98765 43210' },
  { name: 'city', label: 'Where do you currently live?', type: 'text', required: true, maxLength: 80, placeholder: 'e.g. Sector 45, Gurugram' },
  ONSITE_FIELD,
  { name: 'experienceYears', label: 'Total years of experience', type: 'number', required: true, min: 0, max: 50, step: 0.5 },
  { name: 'currentCompany', label: 'Current / most recent company', type: 'text', required: false, maxLength: 120 },
  { name: 'currentRole', label: 'Current / most recent title', type: 'text', required: false, maxLength: 120 },
  { name: 'noticePeriod', label: 'Notice period', type: 'select', required: true, options: NOTICE_PERIODS },
  { name: 'currentCtc', label: 'Current CTC (₹ LPA)', type: 'text', required: false, maxLength: 40, placeholder: 'e.g. 9.5 LPA' },
  { name: 'expectedCtc', label: 'Expected CTC (₹ LPA)', type: 'text', required: true, maxLength: 40, placeholder: 'e.g. 14 LPA' },
  { name: 'linkedin', label: 'LinkedIn profile', type: 'url', required: false, maxLength: 240, placeholder: 'https://linkedin.com/in/…' },
  { name: 'source', label: 'How did you hear about this role?', type: 'select', required: true, options: SOURCES },
];

/** Asked on the final step, after the role-specific questions. */
export const CLOSING_FIELDS = [
  {
    name: 'pitch',
    label: 'Why this role, in your words?',
    type: 'textarea',
    required: true,
    maxLength: 700,
    minLength: 40,
    placeholder: 'A short, specific pitch beats a long generic one. What have you actually shipped that maps to this role?',
  },
];

/** The five hiring tracks. `fields` are asked in addition to the common ones. */
export const CATEGORIES = [
  {
    id: 'crm',
    code: 'CRM',
    title: 'CRM & Retention',
    roleLine: 'CRM Executive · CRM Manager · Retention Lead',
    blurb: 'Own repeat purchase, lifecycle journeys and LTV across email, WhatsApp and SMS.',
    fields: [
      {
        name: 'crmTools',
        label: 'CRM / retention tools you have run',
        type: 'multiselect',
        required: true,
        options: ['Klaviyo', 'WebEngage', 'MoEngage', 'CleverTap', 'Wigzo', 'HubSpot', 'Zoho', 'Salesforce Marketing Cloud', 'Interakt / WATI', 'Other'],
      },
      {
        name: 'crmChannels',
        label: 'Channels you have owned',
        type: 'multiselect',
        required: true,
        options: ['Email', 'WhatsApp', 'SMS', 'Push notifications', 'On-site personalisation', 'Loyalty programme'],
      },
      {
        name: 'crmMetrics',
        label: 'Metrics you were measured on',
        type: 'multiselect',
        required: true,
        options: ['Repeat purchase rate', 'Customer LTV', 'Churn / win-back', 'Retention revenue %', 'Subscription renewals', 'AOV'],
      },
      { name: 'crmD2c', label: 'Worked on a D2C / e-commerce brand before?', type: 'select', required: true, options: ['Yes — Shopify', 'Yes — other platform', 'No, but adjacent', 'No'] },
      { name: 'crmBaseSize', label: 'Largest customer base you have managed', type: 'select', required: true, options: ['Under 10k', '10k – 50k', '50k – 2 lakh', '2 lakh – 10 lakh', 'Over 10 lakh'] },
      { name: 'crmWin', label: 'One retention number you moved (and by how much)', type: 'textarea', required: true, maxLength: 400, minLength: 20, placeholder: 'e.g. Took repeat rate from 18% to 27% in 5 months by rebuilding the day-7 to day-21 WhatsApp flow.' },
    ],
  },
  {
    id: 'offline-marketing',
    code: 'OFM',
    title: 'Offline Marketing',
    roleLine: 'Offline Marketer · BTL & Activations · Trade Marketing',
    blurb: 'Take the brand off the feed and into stores, gyms, clinics, campuses and events.',
    fields: [
      {
        name: 'offChannels',
        label: 'Offline channels you have run',
        type: 'multiselect',
        required: true,
        options: ['BTL activations', 'General trade', 'Modern trade', 'Chemist / pharmacy', 'Gyms & fitness studios', 'Cafés & HoReCa', 'Campus & corporate', 'Events & expos', 'Quick commerce dark stores', 'Sampling programmes'],
      },
      {
        name: 'offRegions',
        label: 'Regions you have covered',
        type: 'multiselect',
        required: true,
        options: ['Delhi NCR', 'Mumbai / MMR', 'Bengaluru', 'Hyderabad', 'Pune', 'Chennai', 'Kolkata', 'Ahmedabad', 'Tier 2 & 3 towns', 'Pan-India'],
      },
      { name: 'offTeamSize', label: 'Largest field team you have managed', type: 'select', required: true, options: ['None — individual contributor', '1 – 5', '6 – 20', '21 – 50', '50+'] },
      { name: 'offBudget', label: 'Largest monthly offline budget you owned (₹)', type: 'select', required: true, options: ['Under ₹1 lakh', '₹1 – 5 lakh', '₹5 – 20 lakh', '₹20 – 50 lakh', 'Over ₹50 lakh'] },
      { name: 'offCategory', label: 'Categories you have sold into', type: 'multiselect', required: true, options: ['Nutraceuticals / supplements', 'FMCG food & beverage', 'Beauty & personal care', 'Pharma', 'Fitness', 'Other'] },
      { name: 'offWin', label: 'Your best offline activation — what and what it returned', type: 'textarea', required: true, maxLength: 400, minLength: 20, placeholder: 'Where, scale, cost, and what it actually delivered in sales or sampling.' },
    ],
  },
  {
    id: 'brand-manager',
    code: 'BRM',
    title: 'Brand Management',
    roleLine: 'Brand Manager · Assistant Brand Manager · Category Lead',
    blurb: 'Own positioning, launches, packaging and the full brand P&L for a product line.',
    fields: [
      {
        name: 'brmCategories',
        label: 'Categories you have managed',
        type: 'multiselect',
        required: true,
        options: ['Nutraceuticals / supplements', 'Wellness & functional foods', 'Beauty & personal care', 'FMCG food & beverage', 'Pharma / OTC', 'Fitness & sports nutrition', 'Other'],
      },
      { name: 'brmLaunches', label: 'Product launches you have led end-to-end', type: 'select', required: true, options: ['None yet', '1 – 2', '3 – 5', '6 – 10', 'More than 10'] },
      { name: 'brmBudget', label: 'Largest annual brand budget you owned (₹)', type: 'select', required: true, options: ['Under ₹10 lakh', '₹10 – 50 lakh', '₹50 lakh – 2 crore', '₹2 – 10 crore', 'Over ₹10 crore'] },
      {
        name: 'brmScope',
        label: 'What has sat inside your remit',
        type: 'multiselect',
        required: true,
        options: ['Positioning & brand strategy', 'Packaging & artwork', 'Pricing & margin', 'New product development', 'Agency management', 'Influencer & creator marketing', 'Consumer research', 'Media planning', 'P&L ownership'],
      },
      { name: 'brmClaims', label: 'Experience with regulated health claims (FSSAI / nutraceutical labelling)?', type: 'select', required: true, options: ['Yes — I have owned it', 'Some exposure', 'No'] },
      { name: 'brmWin', label: 'A brand or launch you are proud of — and the numbers', type: 'textarea', required: true, maxLength: 400, minLength: 20 },
    ],
  },
  {
    id: 'graphic-designer',
    code: 'GDS',
    title: 'Graphic & Motion Design',
    roleLine: 'Graphic Designer · Senior Designer · Motion Designer',
    blurb: 'Packaging, performance creative, social and motion — a portfolio is mandatory here.',
    fields: [
      { name: 'gdsPortfolio', label: 'Portfolio link (Behance / Dribbble / personal site / Drive)', type: 'url', required: true, maxLength: 300, placeholder: 'https://…  — make sure it is publicly viewable' },
      {
        name: 'gdsTools',
        label: 'Tools you are fluent in',
        type: 'multiselect',
        required: true,
        options: ['Figma', 'Adobe Illustrator', 'Adobe Photoshop', 'Adobe InDesign', 'After Effects', 'Premiere Pro', 'Blender / Cinema 4D', 'Canva', 'Procreate'],
      },
      {
        name: 'gdsSpecialties',
        label: 'What you are strongest at',
        type: 'multiselect',
        required: true,
        options: ['Packaging & label design', 'Performance ad creative', 'Social & content design', 'Motion graphics', 'Brand identity systems', 'Website & landing pages', 'Print & OOH', 'Illustration', '3D / product renders'],
      },
      { name: 'gdsMotion', label: 'Comfort with motion / video editing', type: 'select', required: true, options: ['Motion is my primary skill', 'Confident — I ship motion regularly', 'Basic', 'Static design only'] },
      { name: 'gdsOutput', label: 'Realistic creative output per week', type: 'select', required: true, options: ['Under 10 assets', '10 – 25 assets', '25 – 50 assets', '50+ assets'] },
      { name: 'gdsPackaging', label: 'Have you taken packaging artwork to print (dielines, pre-press)?', type: 'select', required: true, options: ['Yes, many times', 'Once or twice', 'No'] },
    ],
  },
  {
    id: 'leadership',
    code: 'CXO',
    title: 'Leadership / CXO',
    roleLine: 'CEO · COO · CMO · CBO · Head of Growth',
    blurb: 'Senior mandates. Treated confidentially and handled directly by the Rocket Recruiters partners.',
    fields: [
      {
        name: 'cxoRole',
        label: 'Mandate you are a fit for',
        type: 'multiselect',
        required: true,
        options: ['CEO', 'COO', 'CMO', 'CBO / Chief Brand Officer', 'CFO', 'CTO', 'Head of Growth', 'Head of Sales', 'VP Marketing'],
      },
      { name: 'cxoPnl', label: 'Largest annual P&L / revenue you have owned (₹)', type: 'select', required: true, options: ['Under ₹5 crore', '₹5 – 25 crore', '₹25 – 100 crore', '₹100 – 500 crore', 'Over ₹500 crore'] },
      { name: 'cxoTeam', label: 'Largest organisation you have led (headcount)', type: 'select', required: true, options: ['Under 10', '10 – 50', '50 – 200', '200 – 1000', 'Over 1000'] },
      {
        name: 'cxoStage',
        label: 'Stages you have operated at',
        type: 'multiselect',
        required: true,
        options: ['Zero to one', 'Early growth (₹1 – 10 cr ARR)', 'Scale-up (₹10 – 100 cr ARR)', 'Large enterprise', 'Turnaround', 'Fundraise / M&A', 'IPO'],
      },
      { name: 'cxoD2c', label: 'D2C / consumer brand experience', type: 'select', required: true, options: ['Built one', 'Scaled one', 'Advised or invested', 'Adjacent industry only'] },
      { name: 'cxoComp', label: 'Compensation structure you expect', type: 'select', required: true, options: ['Fixed salary only', 'Fixed + performance bonus', 'Fixed + equity', 'Largely equity / partnership', 'Open to discussion'] },
      { name: 'cxoCase', label: 'The single result you would want us to reference-check', type: 'textarea', required: true, maxLength: 500, minLength: 20 },
      { name: 'cxoConfidential', label: 'Is your search confidential?', type: 'select', required: true, options: ['Yes — do not contact my current employer', 'No restriction'] },
    ],
  },
];

/** CV upload constraints — enforced on the client for UX and on the server for real. */
export const CV_RULES = {
  maxBytes: 5 * 1024 * 1024,
  extensions: ['.pdf', '.doc', '.docx'],
  mimeTypes: [
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  ],
};

export const APPLICATION_STATUSES = ['new', 'reviewing', 'shortlisted', 'interviewing', 'rejected', 'hired'];

export function getCategory(id) {
  return CATEGORIES.find((c) => c.id === id) || null;
}

/** Everything the browser needs to render the form. */
export function publicSchema() {
  return {
    brand: BRAND,
    commonFields: COMMON_FIELDS,
    closingFields: CLOSING_FIELDS,
    categories: CATEGORIES,
    cvRules: { ...CV_RULES, maxMb: Math.round(CV_RULES.maxBytes / (1024 * 1024)) },
  };
}
