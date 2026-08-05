// Reference knowledge for reps — drug/nutrient depletion data and doctor talking
// points, transcribed from KayBee's reference PDFs. Static content, not
// per-doctor data (see the Doctors tab for that) — meant to be browsed/searched
// before or during a visit.

export const DRUG_NUTRIENT_DATA = [
  {
    category: "Acid-Suppressing Drugs and Antacids",
    description: "H2 antagonists block histamine (H2) receptors on gastric mucosal cells and decrease acid production. Proton-pump inhibitors block the acid transporter pump. Antacids directly neutralize existing acid in the stomach.",
    depletions: "H2 antagonists deplete calcium, folic acid, iron, vitamin B12, and vitamin D. Proton-pump inhibitors deplete magnesium and vitamin B12.",
    suggested: "H2 antagonists and PPIs — Vitamin B12: 25-1000 mcg/day, Magnesium: 250-400 mg/day, Calcium: 500-1000 mg/day. Iron: discuss with healthcare provider. Vitamin D: 25-50 mcg/day. Vitamin C (with H. pylori): 250-500 mg/day. Zinc: 15 mg/day.",
    interactions: "Goldenseal and Ginger may increase stomach acid and interfere with antacids/H2 antagonists/PPIs. Green Tea can inhibit metabolism of caffeine and significantly reduce its clearance with H2 antagonists.",
  },
  {
    category: "Antibiotics",
    description: "Antibiotics are used to treat bacterial infections.",
    depletions: "Deplete calcium, magnesium, potassium, and B vitamins (B1-thiamin, B2-riboflavin, B3-niacin, B5-pantothenic acid, B6, B9-folic acid, B12) and vitamin K.",
    suggested: "Calcium: 500-1000 mg/day (divided doses), Magnesium: 250-400 mg/day.",
    interactions: "Calcium, Iron, Magnesium, Zinc: can affect antibiotic absorption via insoluble complexes. Green Tea Catechins: fluoroquinolones may reduce clearance of caffeine/theophylline, increasing side effects. St. John's Wort: increases photosensitivity risk.",
  },
  {
    category: "Antidepressants",
    description: "Increases levels of biogenic amines (norepinephrine, serotonin, dopamine) in the CNS. Clinical improvement generally takes 3-6 weeks.",
    depletions: "",
    suggested: "Calcium: 500-1000 mg/day, Vitamin D: 25-50 mcg/day, Folic acid: 240 mcg/day.",
    interactions: "Melatonin may interact with SSRIs; endogenous melatonin is reduced by SSRI medications. SAM-e may augment antidepressant effects. St. John's Wort and 5-HTP combined with serotonergic drugs can increase risk of serotonin syndrome.",
  },
  {
    category: "Antiepileptics (Anticonvulsants)",
    description: "Decrease firing of aberrant neurons and/or spread of abnormal activity in the brain.",
    depletions: "",
    suggested: "Calcium: 500 mg/day, Vitamin D: 25-50 mcg/day, Vitamin B12: 25-1000 mcg/day.",
    interactions: "Use caution with Folic acid, Ginkgo biloba, Niacin, and St. John's Wort — may interfere with effectiveness of antiepileptic drugs.",
  },
  {
    category: "Antipsychotics",
    description: "Block receptors for neurotransmitters (dopamine, serotonin), reducing agitation/aggression and stabilizing mood.",
    depletions: "Vitamin B2 (Riboflavin).",
    suggested: "Daily Multivitamin, B Vitamins, Vitamin C: 250-500 mg/day.",
    interactions: "Echinacea may decrease clearance of Zyprexa. Evening Primrose Oil and Ginkgo biloba may increase seizure risk. Ginseng may exacerbate psychiatric conditions. Goldenseal may affect antipsychotic effectiveness. St. John's Wort may cause unpredictable effects and photosensitivity.",
  },
  {
    category: "Anxiety Medication (Benzodiazepines)",
    description: "A class of drugs primarily used to treat anxiety.",
    depletions: "Calcium — these medications decrease calcium absorption by increasing metabolism of vitamin D.",
    suggested: "Calcium: 500-1000 mg/day (divided doses).",
    interactions: "Melatonin: 1-3 mg/day noted as a supportive option. Kava combined with benzodiazepines is not recommended due to similar effects.",
  },
  {
    category: "Birth Control (Oral Contraceptives)",
    description: "Synthetic/semi-synthetic estrogen and/or progesterone analogs used to prevent pregnancy.",
    depletions: "Folic acid, Magnesium, Vitamin B6.",
    suggested: "Folic acid: 240 mcg/day, Magnesium: 250-400 mg/day, Vitamin B6: 2-5 mg/day, Calcium: 500 mg/day, Vitamin B12: 25-1000 mcg/day.",
    interactions: "Copper and Iron: oral contraceptives may increase serum levels. Garlic and St. John's Wort may decrease contraceptive effectiveness. Green Tea: contraceptives can decrease caffeine clearance by 40-65%.",
  },
  {
    category: "Blood Pressure Medication (Anti-hypertensives)",
    description: "ACE inhibitors, ARBs, beta blockers, and calcium channel blockers reduce peripheral resistance and/or cardiac output.",
    depletions: "Beta blockers deplete CoQ10. ACE inhibitors deplete zinc. Calcium channel blockers deplete potassium.",
    suggested: "Calcium: 500-1000 mg/day, Folic acid: 120-240 mcg/day, Magnesium: 250-400 mg/day, CoQ10: 100-200 mg/day. ACE inhibitors — Zinc: 15 mg/day. Calcium channel blockers — Potassium: <=100 mg/day. Iron: take as directed by healthcare provider.",
    interactions: "Calcium (with calcium channel blockers only) may interfere with BP-lowering activity. CoQ10 and Fish Oil may decrease BP further — monitor. Garlic, Ginkgo biloba & St. John's Wort may affect drug metabolism/clearance. Green Tea and Goldenseal may affect therapeutic benefits. Melatonin may impair efficacy of calcium channel blockers. Potassium (with ACE inhibitors/ARBs) increases hyperkalemia risk. Vitamin D interferes with calcium channel blocker (verapamil) activity.",
  },
  {
    category: "Blood Thinning Medication (Anticoagulants/Antiplatelets)",
    description: "Anticoagulants decrease clotting potential via the Prothrombin-Thrombin-Fibrinogen cascade. Antiplatelets decrease clot potential by impacting platelet aggregation.",
    depletions: "",
    suggested: "",
    interactions: "Use caution — increased bleeding risk with: Bilberry, Cod Liver Oil, Dong Quai, Evening Primrose Oil, Feverfew, Fish Oil, Flaxseed Oil, Garlic, Ginger Root, Ginkgo biloba, Ginseng, Glucosamine, Goldenseal, Grape Seed Extract, Green Tea, Horse Chestnut, Milk Thistle, Saw Palmetto, Vitamin C, Vitamin E. Vitamin K: maintain consistent intake, avoid large fluctuations. CoQ10 is structurally similar to vitamin K and may interfere with anticoagulant effectiveness.",
  },
  {
    category: "Cholesterol Lowering Medication (Statins)",
    description: "Statins inhibit HMG CoA reductase, a key step in hepatic cholesterol synthesis, increasing the liver's removal of circulating LDL cholesterol. Note: HMG CoA reductase is also key in CoQ10 synthesis.",
    depletions: "CoQ10, Vitamin A, Vitamin D, Vitamin E.",
    suggested: "CoQ10: 100-200 mg/day, Vitamin D: 25-50 mcg/day. Daily Multivitamin/mineral supplement, Fish Oil: 500-1000 mg EPA+DHA/day.",
    interactions: "Garlic (containing allicin) and St. John's Wort may impact CYP450 metabolism and affect statin effectiveness. Red Yeast Rice also lowers cholesterol and should not be taken with statins without supervision. Vitamin A levels may need monitoring with long-term statin use.",
  },
  {
    category: "Corticosteroids",
    description: "Synthetic compounds that mimic hormones from the adrenal glands, relieving inflammation, pain, and discomfort.",
    depletions: "Calcium, Vitamin D, Magnesium, Potassium, Chromium.",
    suggested: "Calcium: 500 mg/day, Vitamin D: 25-50 mcg/day, Magnesium: 250-400 mg/day, Potassium: <=100 mg/day, Chromium: 50-200 mcg/day.",
    interactions: "Use caution with Herbal Supplements, Licorice, and St. John's Wort — may interfere with medication effectiveness.",
  },
  {
    category: "Diabetes Medication (Oral Hypoglycemics)",
    description: "",
    depletions: "Folic acid, Vitamin B12, Calcium, Vitamin D.",
    suggested: "Folic acid: 120-240 mcg/day, Vitamin B12: 25-1000 mcg/day, Calcium: 500 mg/day, Vitamin D: 25-50 mcg/day.",
    interactions: "Use caution — may cause additive blood-glucose-lowering effects or hypoglycemia risk with: Alfalfa, Aloe Vera, Alpha Lipoic Acid, Bilberry, CoQ10, Chromium, Garlic, Ginkgo biloba, Ginseng, Green Tea, Melatonin, Milk Thistle, Niacin, St. John's Wort, Vitamin K1.",
  },
  {
    category: "Digoxin",
    description: "Derived from the leaves of the Digitalis lanata plant (foxglove). Used to treat heart failure and atrial fibrillation.",
    depletions: "Calcium, Magnesium, Phosphorus, Potassium, Vitamin B1 (Thiamin).",
    suggested: "Calcium: 500-1000 mg/day (divided doses), Magnesium: 250-400 mg/day, Potassium: <=100 mg/day.",
    interactions: "Calcium: high levels increase toxic reaction risk; low levels interfere with digoxin function — monitor with a healthcare professional. Hawthorn may enhance digoxin activity. St. John's Wort may reduce serum digoxin levels.",
  },
  {
    category: "Diuretics",
    description: "",
    depletions: "Loop diuretics (esp. furosemide) increase calcium excretion, decrease calcium status. Thiazide diuretics deplete magnesium and potassium. Potassium-sparing diuretics deplete folic acid.",
    suggested: "Loop diuretics — Calcium: 500-1000 mg/day. Thiazide diuretics — Magnesium: 250-400 mg/day, Potassium: <100 mg/day, Zinc: 15 mg/day. Potassium-sparing diuretics — Folic acid: 240 mcg/day.",
    interactions: "Calcium may increase hypercalcemia/metabolic alkalosis/renal failure risk. CoQ10 and Fish Oil may have additive BP-lowering effects, risking hypotension. Ginkgo biloba may reduce diuretic effectiveness.",
  },
  {
    category: "Hormone Replacement Therapy (Estrogens)",
    description: "Used to replace female hormones no longer produced after menopause.",
    depletions: "Folic acid, Magnesium, Vitamin B6, Vitamin B12.",
    suggested: "Folic acid: 240 mcg/day, Magnesium: 250-400 mg/day, Vitamin B6: 2-5 mg/day, Vitamin B12: 25-1000 mcg/day.",
    interactions: "Caffeine's stimulating effects may increase due to inhibited clearance. Calcium and Vitamin D may increase absorption of HRT (recommended to support bone density). Red Clover Extract and Soy Isoflavones may interfere with HRT activity. St. John's Wort may alter hormone metabolism — not recommended during HRT. Zinc and Magnesium excretion is reduced by HRT.",
  },
];

// Part 1 of KayBee's internal notes: general condition/use -> supplement mapping
export const CONDITION_TALKING_POINTS = [
  { condition: "Anxiety", items: ["Valerian", "Ashwagandha", "Ginkgo Biloba", "Mushroom Power EGCG & Matcha", "Magnesium Glycinate"] },
  { condition: "Cholesterol", items: ["Garlic", "Niacin", "Fish Oil", "Flaxseed", "Fibers (psyllium)"] },
  { condition: "Diabetes", items: ["Chromium", "Ginseng", "L-carnitine", "Berberine", "Fish Oil/Flaxseed", "Garlic"] },
  { condition: "Hypertension", items: ["Fish Oil", "L-arginine", "CoQ10", "Garlic", "Vitamin D"] },
  { condition: "Migraine/Headaches", items: ["Prevent: Fish oil, Magnesium, CoQ10, Melatonin, Ginkgo Biloba", "Treat: Caffeine, Magnesium"] },
  { condition: "Osteoporosis", items: ["Calcium", "Vitamin D", "Magnesium", "Zn", "Flaxseed", "Soy lecithin"] },
  { condition: "ADHD", items: ["Fish oil", "Evening primrose oil", "Flaxseed oil", "Zn, Fe, Mg"] },
  { condition: "Cold & Flu", items: ["Prevent: Echinacea, Zinc, Garlic, Vitamin C", "Treat: Echinacea, Zinc, Vitamin C, NAC (mucus)"] },
  { condition: "Dyspepsia", items: ["Calcium carbonate", "Magnesium", "Ginger"] },
  { condition: "IBD", items: ["Diarrhea: fibers, Probiotics (lacto, saccharomyces boulardii, or bifidobacterium)", "Avoid: senna and cascara"] },
  { condition: "Motion sickness/Nausea", items: ["Ginger"] },
  { condition: "Prostate enlargement", items: ["Saw palmetto", "Vitamin E", "Garlic", "Selenium"] },
  { condition: "Cancer prevention", items: ["Beta-carotene", "Fish oil", "Garlic (bleeding!)"] },
  { condition: "Depression", items: ["Fish oil", "Ginkgo biloba", "DHEA (increase caution)"] },
  { condition: "Energy/Weight loss", items: ["Apple cider vinegar", "Psyllium", "Ginseng", "MACA", "Mushroom Power EGCG & Matcha", "B-complex", "NAD+ Plus Resveratrol"] },
  { condition: "Insomnia/Sleep", items: ["Melatonin", "Valerian", "Co-Q10 (if due to HF)", "Magnesium glycinate"] },
  { condition: "Menopause", items: ["Ginseng", "Soy lecithin", "Flaxseed", "DHEA", "MACA"] },
  { condition: "Skin conditions", items: ["Collagen C", "Biotin (hair loss, nail conditions)", "NAD+ Plus Resveratrol"] },
  { condition: "Canker sores/Aphthous ulcers", items: ["L-lysine"] },
  { condition: "Dementia/Memory", items: ["Ginkgo biloba", "Vitamin E (max 400 IU QD)", "Folate", "Coconut oil", "NAD+ Resveratrol"] },
  { condition: "Heart health/Heart failure", items: ["CoQ10", "L-arginine", "Vitamin B-1", "Vitamin B-12", "Fish oil", "Mushroom Power EGCG & Matcha", "If deficient: Mg or Thiamine (B1)"] },
  { condition: "Liver disease", items: ["Milk thistle (detox liver)", "NAC"] },
  { condition: "Osteoarthritis", items: ["Glucosamine", "Chondroitin", "MSM", "Turmeric"] },
  { condition: "UTI", items: ["Cranberry", "Garlic", "Echinacea", "Probiotics (bifido & lactobacillus)"] },
  { condition: "Libido", items: ["MACA", "Libimax"] },
  { condition: "Pediatrics", items: ["Little animals", "Super gummy bears"] },
  { condition: "OBGYN/Fertility", items: ["NAC", "Ginger", "B-6"] },
  { condition: "Immunity", items: ["Mushroom Power EGCG & Matcha", "Vitamin C", "Vitamin D", "Turmeric", "Zinc", "Vitamin A, E"] },
  { condition: "Anemia", items: ["B-12", "B-complex", "B-9", "B-1"] },
  { condition: "Constipation", items: ["Magnesium citrate", "Vitamin C"] },
];

export const BCOMPLEX_INFO = [
  { vitamin: "B1 (Thiamine)", note: "Critical for heart health and energy metabolism." },
  { vitamin: "B2 (Riboflavin)", note: "Supports energy production, often found in eggs and dairy. Deficiency rarely occurs in isolation." },
  { vitamin: "B3 (Niacin)", note: "Used clinically for cholesterol management (dyslipidemia) and to lower risk of recurrent myocardial infarction." },
  { vitamin: "B5 (Pantothenic Acid)", note: "Essential for lipid metabolism and hormone production." },
  { vitamin: "B6 (Pyridoxine)", note: "Recommended for nausea and vomiting during pregnancy and treating neurological toxicities from certain medications." },
  { vitamin: "B7 (Biotin)", note: "Often taken for hair, skin, and nail conditions." },
  { vitamin: "B9 (Folate/Folic Acid)", note: "Crucial for preventing neural tube defects in pregnancy and supporting cell division." },
  { vitamin: "B12 (Cobalamin)", note: "Vital for nerve function and preventing megaloblastic anemia." },
];

export const DIABETES_SUPPLEMENT_INTERACTIONS = [
  { supplement: "Flaxseed", glucoseEffect: "Decreased A1c", antidiabeticInteraction: "Potential additive effect" },
  { supplement: "Garlic", glucoseEffect: "May increase/enhance insulin", antidiabeticInteraction: "Use with caution" },
  { supplement: "Ginkgo", glucoseEffect: "Risk of hypoglycemia", antidiabeticInteraction: "Known interaction" },
  { supplement: "Glucosamine", glucoseEffect: "Can elevate blood glucose", antidiabeticInteraction: "Known interaction" },
  { supplement: "Melatonin", glucoseEffect: "Can cause hyperglycemia", antidiabeticInteraction: "May decrease drug efficacy" },
];

// Part 2 of KayBee's internal notes: medical specialty -> topic -> supplements
export const SPECIALTY_TALKING_POINTS = [
  {
    specialty: "Cardiology",
    topics: [
      { topic: "Cholesterol", text: "Garlic, Niacin, fibers (such as psyllium), and Fish oil/Cod Liver Oil." },
      { topic: "Hypertension (High Blood Pressure)", text: "Garlic, Vitamin D, L-arginine, CoQ10, and Fish oil/Cod Liver Oil." },
      { topic: "Antioxidants", text: "Dietary intake of Vitamin A and Vitamin E has been associated with reduced cardiovascular disease risk, though sources distinguish between dietary intake and supplement use." },
      { topic: "Heart Health", text: "Magnesium and Thiamine (B1) recommended for heart health, specifically if a deficiency is present. Ginkgo biloba, Resveratrol." },
    ],
  },
  {
    specialty: "Emergency care/medicine",
    topics: [
      { topic: "Toxicology & Overdose Support", text: "Vitamin B6 (Pyridoxine) is indicated for preventing/treating neurological toxicities (seizures, coma) associated with isoniazid overdose. Folic Acid (B9) is used for methanol toxicity." },
      { topic: "Neurological Emergencies", text: "Thiamine (B1) is used to treat Wernicke's encephalopathy (mental confusion, visual changes, ataxia), often associated with alcoholism." },
    ],
  },
  {
    specialty: "Gastroenterology",
    topics: [
      { topic: "Gut health", text: "Chewable Papaya, Ginger, Apple Cider Vinegar, magnesium citrate, GLUTAMINE." },
      { topic: "IBD & Dyspepsia", text: "Discuss the roles of Stress B-complex with Zinc, Iron, and Magnesium." },
      { topic: "Liver Disease", text: "Highlight Milk Thistle for liver detox and SAMe." },
      { topic: "Other", text: "Bariatric surgery, Worm disease, IBD, H.pylori -> B12." },
    ],
  },
  {
    specialty: "General medicine",
    topics: [
      { topic: "Diabetes", text: "Chromium Picolinate 200mcg, Ginseng, Psyllium, Acetyl-L-carnitine, Berberine." },
      { topic: "Anxiety", text: "Valerian." },
      { topic: "Immune Support", text: "Focus on Vitamin C, Stress B-complex with Zinc, Echinacea, Garlic, and Vitamin D." },
      { topic: "Energy & Vitality", text: "Discuss NAD+ with Resveratrol, Vitamin B-Complex, and Magnesium." },
      { topic: "Migraine/Headaches", text: "Prevent: Fish oil, Magnesium. Prevent and treat: CoQ10, Melatonin, Vitamin B-2." },
      { topic: "Metabolism", text: "Chromium and Apple cider are used for energy and weight management." },
      { topic: "Tinnitus", text: "Ginkgo biloba." },
      { topic: "Memory", text: "Memorin, Ginkgo biloba." },
    ],
  },
  {
    specialty: "Internal medicine",
    topics: [
      { topic: "Diabetes", text: "Chromium Picolinate 200mcg, Ginseng, Psyllium, Acetyl-L-carnitine, Berberine." },
    ],
  },
  {
    specialty: "Nephrology/Urology",
    topics: [
      { topic: "Daily Multi Vitamins", text: "Iron Free 100 Tabs (mason)." },
      { topic: "Dialysis Support", text: "Patients on long-term dialysis often require Vitamin B2 (Riboflavin) and Vitamin B6 (Pyridoxine) loss during hemodialysis." },
      { topic: "Precautions", text: "Medical reps should note that large doses of Vitamin C should be avoided in patients with renal disorders." },
      { topic: "Urology", text: "Highly Concentrated Cranberry with Probiotic, Saw Palmetto for UTI and prostate enlargement. MACA — common supplement for male reproductive health and vitality." },
    ],
  },
  {
    specialty: "Neurology",
    topics: [
      { topic: "Migraine/Headaches", text: "Prevent: Fish oil, Magnesium (prevent and treat), CoQ10, Melatonin AND Vitamin B-2." },
      { topic: "Cognitive Health & Dementia", text: "Focus on Ginkgo biloba, Vitamin E, Folate, and NAD+ with Resveratrol." },
      { topic: "Neuropathy & Nerve Support", text: "Recommend Vitamin B6 and Vitamin B12 for peripheral neuropathy. Thiamine (B1) is essential for the nervous system." },
      { topic: "Sleep & Mood", text: "Discuss Melatonin, Valerian, Ashwagandha and magnesium with melatonin for insomnia and anxiety." },
    ],
  },
  {
    specialty: "Obstetrics and gynecology",
    topics: [
      { topic: "Endometriosis and fertility", text: "NAC, Magnesium, Vitamin D and C." },
      { topic: "Prenatal Care", text: "Folic Acid (B9) is essential at least one month before and during early pregnancy to prevent neural tube defects." },
      { topic: "Pregnancy Support", text: "Ginger and/or Vitamin B6 recommended for nausea and vomiting of pregnancy." },
      { topic: "Menopause", text: "Highlight Soy lecithin, Ginseng, Flaxseed, MACA, and Evening Primrose." },
      { topic: "Perfect Multivitamin for women", text: "Women's daily (mason)." },
    ],
  },
  {
    specialty: "Oncology/hematology",
    topics: [
      { topic: "Anemia", text: "Discuss Folate (B9), Vitamin B12, Vitamin B2, and Vitamin A for their various roles in hematopoiesis and treating different types of anemia." },
    ],
  },
  {
    specialty: "Ophthalmology",
    topics: [
      { topic: "Vision Health", text: "Beta Carotene/Vitamin A (Retinol) is crucial for visual adaptation to darkness and treating night blindness." },
      { topic: "Eye Protection", text: "Omega-3 fatty acids (Fish Oil) are linked to overall eye health, especially dry eyes." },
    ],
  },
  {
    specialty: "Orthopedics",
    topics: [
      { topic: "Bone & Joint Support", text: "Alflexil, Turmeric, Fish Oil." },
      { topic: "Bone Density", text: "Focus on Calcium, Vitamin D, Magnesium, Vitamin K, and Soy for osteoporosis and general bone health." },
      { topic: "Flexibility", text: "Glucosamine & Fish Oil noted by users for improving joint flexibility and reducing stiffness." },
      { topic: "Calcium types", text: "Note: all calcium types should be mentioned with their differences and uses — Calcium 500+vit D3 Oyster Shell 60 tabs (mason), Calcium 600mg 100tab(mason), Calcium Citrate+vit D3 60 Caplets (mason), Calcium Magnesium Zinc 100tab(mason), Chewable Calcium 600 + Vitamin D3 100tab(mason)." },
    ],
  },
  {
    specialty: "Pediatrics",
    topics: [
      { topic: "Growth & Development", text: "Focus on Little Animals Children's Multivitamins and Super Gummy Bears." },
    ],
  },
  {
    specialty: "Plastic surgery",
    topics: [
      { topic: "Wound Healing & Skin Health", text: "Vitamin A, Vitamin C, and Zinc are essential for collagen synthesis, epithelial cell regulation, and wound healing." },
      { topic: "Beauty & Aesthetics", text: "Biotin, Collagen C, Hair Nails Vitamins, and Vitamin E are recommended for hair, skin, and nail conditions. NAD+ Plus Resveratrol." },
    ],
  },
  {
    specialty: "Pulmonology",
    topics: [
      { topic: "Immunity boost", text: "Dietary intake of Vitamin A, Vitamin E, Vitamin C, Vitamin D, and Zinc, or Stress B-complex with zinc." },
      { topic: "Asthma Support", text: "Omega-3 Fatty Acids (Fish Oil) are researched for asthma management." },
      { topic: "Mucus relief", text: "NAC." },
    ],
  },
];

// Standing translation notes from the original document
export const TALKING_POINTS_NOTES = [
  "When text says ZINC -> mention stress B-complex (mason)",
  "When text says Calcium -> mention them all (see Orthopedics calcium types)",
  "When text says Fish oil -> remember Omega-3, Flaxseed, Salmon Oil, and Cod Liver Oil",
];
