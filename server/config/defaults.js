const defaultCategories = [
  {
    id: 'cat-food',
    name: 'Food & Drink',
    emoji: '🍽️',
    isDefault: true,
    sortOrder: 0,
    subcategories: [
      { id: 'sub-groceries', name: 'Groceries', sortOrder: 0 },
      { id: 'sub-dining', name: 'Dining Out', sortOrder: 1 },
      { id: 'sub-takeaway', name: 'Takeaway', sortOrder: 2 },
      { id: 'sub-coffee', name: 'Coffee & Snacks', sortOrder: 3 },
      { id: 'sub-alcohol', name: 'Alcohol & Drinks', sortOrder: 4 }
    ]
  },
  {
    id: 'cat-bills',
    name: 'Bills & Utilities',
    emoji: '📄',
    isDefault: true,
    sortOrder: 1,
    subcategories: [
      { id: 'sub-gas-electric', name: 'Gas & Electric', sortOrder: 0 },
      { id: 'sub-water', name: 'Water', sortOrder: 1 },
      { id: 'sub-council-tax', name: 'Council Tax', sortOrder: 2 },
      { id: 'sub-internet', name: 'Internet & Phone', sortOrder: 3 },
      { id: 'sub-tv-licence', name: 'TV Licence', sortOrder: 4 },
      { id: 'sub-mobile', name: 'Mobile Phone', sortOrder: 5 }
    ]
  },
  {
    id: 'cat-housing',
    name: 'Housing',
    emoji: '🏠',
    isDefault: true,
    sortOrder: 2,
    subcategories: [
      { id: 'sub-rent', name: 'Rent', sortOrder: 0 },
      { id: 'sub-mortgage', name: 'Mortgage', sortOrder: 1 },
      { id: 'sub-maintenance', name: 'Maintenance & Repairs', sortOrder: 2 },
      { id: 'sub-furnishings', name: 'Furnishings', sortOrder: 3 },
      { id: 'sub-garden', name: 'Garden', sortOrder: 4 }
    ]
  },
  {
    id: 'cat-transport',
    name: 'Transport',
    emoji: '🚗',
    isDefault: true,
    sortOrder: 3,
    subcategories: [
      { id: 'sub-fuel', name: 'Fuel', sortOrder: 0 },
      { id: 'sub-public-transport', name: 'Public Transport', sortOrder: 1 },
      { id: 'sub-car-insurance', name: 'Car Insurance', sortOrder: 2 },
      { id: 'sub-car-tax', name: 'Car Tax', sortOrder: 3 },
      { id: 'sub-parking', name: 'Parking', sortOrder: 4 },
      { id: 'sub-car-maintenance', name: 'Car Maintenance', sortOrder: 5 },
      { id: 'sub-taxi', name: 'Taxi & Uber', sortOrder: 6 }
    ]
  },
  {
    id: 'cat-shopping',
    name: 'Shopping',
    emoji: '🛍️',
    isDefault: true,
    sortOrder: 4,
    subcategories: [
      { id: 'sub-clothing', name: 'Clothing', sortOrder: 0 },
      { id: 'sub-electronics', name: 'Electronics', sortOrder: 1 },
      { id: 'sub-household-items', name: 'Household Items', sortOrder: 2 },
      { id: 'sub-gifts', name: 'Gifts', sortOrder: 3 },
      { id: 'sub-online-shopping', name: 'Online Shopping', sortOrder: 4 }
    ]
  },
  {
    id: 'cat-entertainment',
    name: 'Entertainment',
    emoji: '🎬',
    isDefault: true,
    sortOrder: 5,
    subcategories: [
      { id: 'sub-streaming', name: 'Streaming Services', sortOrder: 0 },
      { id: 'sub-cinema', name: 'Cinema & Theatre', sortOrder: 1 },
      { id: 'sub-games', name: 'Games & Apps', sortOrder: 2 },
      { id: 'sub-music', name: 'Music & Concerts', sortOrder: 3 },
      { id: 'sub-hobbies', name: 'Hobbies', sortOrder: 4 },
      { id: 'sub-books', name: 'Books & Magazines', sortOrder: 5 }
    ]
  },
  {
    id: 'cat-health',
    name: 'Health & Wellbeing',
    emoji: '💊',
    isDefault: true,
    sortOrder: 6,
    subcategories: [
      { id: 'sub-pharmacy', name: 'Pharmacy', sortOrder: 0 },
      { id: 'sub-gym', name: 'Gym & Fitness', sortOrder: 1 },
      { id: 'sub-dentist', name: 'Dentist', sortOrder: 2 },
      { id: 'sub-optician', name: 'Optician', sortOrder: 3 },
      { id: 'sub-private-health', name: 'Private Healthcare', sortOrder: 4 },
      { id: 'sub-beauty', name: 'Beauty & Personal Care', sortOrder: 5 }
    ]
  },
  {
    id: 'cat-insurance',
    name: 'Insurance',
    emoji: '🛡️',
    isDefault: true,
    sortOrder: 7,
    subcategories: [
      { id: 'sub-home-insurance', name: 'Home Insurance', sortOrder: 0 },
      { id: 'sub-life-insurance', name: 'Life Insurance', sortOrder: 1 },
      { id: 'sub-pet-insurance', name: 'Pet Insurance', sortOrder: 2 },
      { id: 'sub-travel-insurance', name: 'Travel Insurance', sortOrder: 3 },
      { id: 'sub-health-insurance', name: 'Health Insurance', sortOrder: 4 }
    ]
  },
  {
    id: 'cat-travel',
    name: 'Travel & Holidays',
    emoji: '✈️',
    isDefault: true,
    sortOrder: 8,
    subcategories: [
      { id: 'sub-flights', name: 'Flights', sortOrder: 0 },
      { id: 'sub-hotels', name: 'Hotels & Accommodation', sortOrder: 1 },
      { id: 'sub-holiday-activities', name: 'Activities & Tours', sortOrder: 2 },
      { id: 'sub-holiday-food', name: 'Holiday Food & Drink', sortOrder: 3 }
    ]
  },
  {
    id: 'cat-children',
    name: 'Children',
    emoji: '👶',
    isDefault: true,
    sortOrder: 9,
    subcategories: [
      { id: 'sub-childcare', name: 'Childcare', sortOrder: 0 },
      { id: 'sub-school', name: 'School Fees & Supplies', sortOrder: 1 },
      { id: 'sub-kids-activities', name: 'Activities & Clubs', sortOrder: 2 },
      { id: 'sub-kids-clothes', name: 'Children Clothing', sortOrder: 3 },
      { id: 'sub-toys', name: 'Toys & Games', sortOrder: 4 }
    ]
  },
  {
    id: 'cat-pets',
    name: 'Pets',
    emoji: '🐾',
    isDefault: true,
    sortOrder: 10,
    subcategories: [
      { id: 'sub-pet-food', name: 'Pet Food', sortOrder: 0 },
      { id: 'sub-vet', name: 'Vet Bills', sortOrder: 1 },
      { id: 'sub-pet-supplies', name: 'Pet Supplies', sortOrder: 2 },
      { id: 'sub-grooming', name: 'Grooming', sortOrder: 3 }
    ]
  },
  {
    id: 'cat-income',
    name: 'Income',
    emoji: '💰',
    isDefault: true,
    sortOrder: 11,
    subcategories: [
      { id: 'sub-salary', name: 'Salary', sortOrder: 0 },
      { id: 'sub-benefits', name: 'Benefits', sortOrder: 1 },
      { id: 'sub-interest-income', name: 'Interest', sortOrder: 2 },
      { id: 'sub-refunds', name: 'Refunds', sortOrder: 3 },
      { id: 'sub-side-income', name: 'Side Income', sortOrder: 4 },
      { id: 'sub-gifts-received', name: 'Gifts Received', sortOrder: 5 }
    ]
  },
  {
    id: 'cat-savings',
    name: 'Savings & Investments',
    emoji: '📈',
    isDefault: true,
    sortOrder: 12,
    subcategories: [
      { id: 'sub-savings-transfer', name: 'Savings', sortOrder: 0 },
      { id: 'sub-isa', name: 'ISA', sortOrder: 1 },
      { id: 'sub-pension', name: 'Pension', sortOrder: 2 },
      { id: 'sub-investments', name: 'Investments', sortOrder: 3 }
    ]
  },
  {
    id: 'cat-fees',
    name: 'Fees & Charges',
    emoji: '💳',
    isDefault: true,
    sortOrder: 13,
    subcategories: [
      { id: 'sub-bank-fees', name: 'Bank Fees', sortOrder: 0 },
      { id: 'sub-credit-card-fees', name: 'Credit Card Fees', sortOrder: 1 },
      { id: 'sub-atm-fees', name: 'ATM Fees', sortOrder: 2 },
      { id: 'sub-late-fees', name: 'Late Payment Fees', sortOrder: 3 }
    ]
  },
  {
    id: 'cat-subscriptions',
    name: 'Subscriptions',
    emoji: '🔄',
    isDefault: true,
    sortOrder: 14,
    subcategories: [
      { id: 'sub-software', name: 'Software & Apps', sortOrder: 0 },
      { id: 'sub-memberships', name: 'Memberships', sortOrder: 1 },
      { id: 'sub-news', name: 'News & Publications', sortOrder: 2 },
      { id: 'sub-other-subs', name: 'Other Subscriptions', sortOrder: 3 }
    ]
  },
  {
    id: 'cat-education',
    name: 'Education',
    emoji: '📚',
    isDefault: true,
    sortOrder: 15,
    subcategories: [
      { id: 'sub-courses', name: 'Courses', sortOrder: 0 },
      { id: 'sub-books-materials', name: 'Books & Materials', sortOrder: 1 },
      { id: 'sub-tuition', name: 'Tuition Fees', sortOrder: 2 }
    ]
  },
  {
    id: 'cat-charity',
    name: 'Charity & Donations',
    emoji: '❤️',
    isDefault: true,
    sortOrder: 16,
    subcategories: [
      { id: 'sub-charity-donation', name: 'Charity Donations', sortOrder: 0 },
      { id: 'sub-fundraising', name: 'Fundraising', sortOrder: 1 },
      { id: 'sub-religious', name: 'Religious Donations', sortOrder: 2 }
    ]
  },
  {
    id: 'cat-transfer',
    name: 'Transfer',
    emoji: '↔️',
    isDefault: true,
    isSystem: true,
    sortOrder: 98,
    subcategories: []
  },
  {
    id: 'cat-uncategorized',
    name: 'Uncategorized',
    emoji: '❓',
    isDefault: true,
    isSystem: true,
    sortOrder: 99,
    subcategories: []
  }
];

module.exports = { defaultCategories };
