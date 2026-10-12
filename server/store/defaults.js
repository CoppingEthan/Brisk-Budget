// The default UK household categories. Colours match the badges the app has always used.
const DEFAULTS = [
  { id: "cat-food", name: "Food & Drink", emoji: "🍽️", color: "#fb923c", subs: [["sub-groceries","Groceries"], ["sub-dining","Dining Out"], ["sub-takeaway","Takeaway"], ["sub-coffee","Coffee & Snacks"], ["sub-alcohol","Alcohol & Drinks"]] },
  { id: "cat-bills", name: "Bills & Utilities", emoji: "📄", color: "#facc15", subs: [["sub-gas-electric","Gas & Electric"], ["sub-water","Water"], ["sub-council-tax","Council Tax"], ["sub-internet","Internet & Phone"], ["sub-tv-licence","TV Licence"], ["sub-mobile","Mobile Phone"]] },
  { id: "cat-housing", name: "Housing", emoji: "🏠", color: "#60a5fa", subs: [["sub-rent","Rent"], ["sub-mortgage","Mortgage"], ["sub-maintenance","Maintenance & Repairs"], ["sub-furnishings","Furnishings"], ["sub-garden","Garden"]] },
  { id: "cat-transport", name: "Transport", emoji: "🚗", color: "#818cf8", subs: [["sub-fuel","Fuel"], ["sub-public-transport","Public Transport"], ["sub-car-insurance","Car Insurance"], ["sub-car-tax","Car Tax"], ["sub-parking","Parking"], ["sub-car-maintenance","Car Maintenance"], ["sub-taxi","Taxi & Uber"]] },
  { id: "cat-shopping", name: "Shopping", emoji: "🛍️", color: "#f472b6", subs: [["sub-clothing","Clothing"], ["sub-electronics","Electronics"], ["sub-household-items","Household Items"], ["sub-gifts","Gifts"], ["sub-online-shopping","Online Shopping"]] },
  { id: "cat-entertainment", name: "Entertainment", emoji: "🎬", color: "#c084fc", subs: [["sub-streaming","Streaming Services"], ["sub-cinema","Cinema & Theatre"], ["sub-games","Games & Apps"], ["sub-music","Music & Concerts"], ["sub-hobbies","Hobbies"], ["sub-books","Books & Magazines"]] },
  { id: "cat-health", name: "Health & Wellbeing", emoji: "💊", color: "#f87171", subs: [["sub-pharmacy","Pharmacy"], ["sub-gym","Gym & Fitness"], ["sub-dentist","Dentist"], ["sub-optician","Optician"], ["sub-private-health","Private Healthcare"], ["sub-beauty","Beauty & Personal Care"]] },
  { id: "cat-insurance", name: "Insurance", emoji: "🛡️", color: "#2dd4bf", subs: [["sub-home-insurance","Home Insurance"], ["sub-life-insurance","Life Insurance"], ["sub-pet-insurance","Pet Insurance"], ["sub-travel-insurance","Travel Insurance"], ["sub-health-insurance","Health Insurance"]] },
  { id: "cat-travel", name: "Travel & Holidays", emoji: "✈️", color: "#22d3ee", subs: [["sub-flights","Flights"], ["sub-hotels","Hotels & Accommodation"], ["sub-holiday-activities","Activities & Tours"], ["sub-holiday-food","Holiday Food & Drink"]] },
  { id: "cat-children", name: "Children", emoji: "👶", color: "#fb7185", subs: [["sub-childcare","Childcare"], ["sub-school","School Fees & Supplies"], ["sub-kids-activities","Activities & Clubs"], ["sub-kids-clothes","Children Clothing"], ["sub-toys","Toys & Games"]] },
  { id: "cat-pets", name: "Pets", emoji: "🐾", color: "#f59e0b", subs: [["sub-pet-food","Pet Food"], ["sub-vet","Vet Bills"], ["sub-pet-supplies","Pet Supplies"], ["sub-grooming","Grooming"]] },
  { id: "cat-income", name: "Income", emoji: "💰", color: "#34d399", subs: [["sub-salary","Salary"], ["sub-benefits","Benefits"], ["sub-interest-income","Interest"], ["sub-refunds","Refunds"], ["sub-side-income","Side Income"], ["sub-gifts-received","Gifts Received"]] },
  { id: "cat-savings", name: "Savings & Investments", emoji: "📈", color: "#4ade80", subs: [["sub-savings-transfer","Savings"], ["sub-isa","ISA"], ["sub-pension","Pension"], ["sub-investments","Investments"]] },
  { id: "cat-fees", name: "Fees & Charges", emoji: "💳", color: "#94a3b8", subs: [["sub-bank-fees","Bank Fees"], ["sub-credit-card-fees","Credit Card Fees"], ["sub-atm-fees","ATM Fees"], ["sub-late-fees","Late Payment Fees"]] },
  { id: "cat-subscriptions", name: "Subscriptions", emoji: "🔄", color: "#a78bfa", subs: [["sub-software","Software & Apps"], ["sub-memberships","Memberships"], ["sub-news","News & Publications"], ["sub-other-subs","Other Subscriptions"]] },
  { id: "cat-education", name: "Education", emoji: "📚", color: "#38bdf8", subs: [["sub-courses","Courses"], ["sub-books-materials","Books & Materials"], ["sub-tuition","Tuition Fees"]] },
  { id: "cat-charity", name: "Charity & Donations", emoji: "❤️", color: "#e879f9", subs: [["sub-charity-donation","Charity Donations"], ["sub-fundraising","Fundraising"], ["sub-religious","Religious Donations"]] },
  { id: "cat-transfer", name: "Transfer", emoji: "↔️", color: "#818cf8", isSystem: true, subs: [] },
  { id: "cat-uncategorized", name: "Uncategorized", emoji: "❓", color: "#94a3b8", isSystem: true, subs: [] }
];

export const TRANSFER_CATEGORY_ID = 'cat-transfer';
export const UNCATEGORIZED_ID = 'cat-uncategorized';
export const INCOME_CATEGORY_ID = 'cat-income';
export const IMPORTED_CATEGORY_ID = 'cat-imported';

// Extra colours handed to custom categories, in order
export const CATEGORY_PALETTE = [
  '#fb923c', '#facc15', '#60a5fa', '#818cf8', '#f472b6', '#c084fc', '#f87171', '#2dd4bf',
  '#22d3ee', '#fb7185', '#f59e0b', '#34d399', '#4ade80', '#a78bfa', '#38bdf8', '#e879f9'
];

export const DEFAULT_COLOURS = Object.fromEntries(DEFAULTS.map(c => [c.id, c.color]));

export function defaultCategories() {
  return DEFAULTS.map((c, i) => {
    const category = {
      id: c.id,
      name: c.name,
      emoji: c.emoji,
      color: c.color,
      isDefault: true,
      sortOrder: c.isSystem ? 98 + (c.id === UNCATEGORIZED_ID ? 1 : 0) : i,
      subcategories: c.subs.map(([id, name], j) => ({ id, name, sortOrder: j }))
    };
    if (c.isSystem) category.isSystem = true;
    return category;
  });
}

export function systemCategory(id) {
  return defaultCategories().find(c => c.id === id);
}

export const DEFAULT_SETTINGS = {
  currencySymbol: '£',
  name: '',
  groupChartToggles: true,
  checkForUpdates: true
};

export const ACCOUNT_TYPES = ['bank', 'savings', 'credit', 'loan', 'mortgage', 'investment', 'asset'];
export const LIABILITY_TYPES = ['credit', 'loan', 'mortgage'];
export const ASSET_VALUE_TYPES = ['loan', 'investment', 'asset', 'mortgage'];
