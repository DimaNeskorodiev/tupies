// Versioned public fixtures with explicit agent-authored relevance labels, pending human review.
// Labels are reviewable ground-truth declarations, never derived from the ranking algorithm's output.
export const CORPUS_VERSION='2026-10-28.1';
const fact=(id,key,value,date,pinned=false)=>({id,key,value,updatedAt:`${date}T12:00:00.000Z`,...(pinned?{pinned:true}:{}),provenance:{kind:'owner-edit',observedAt:`${date}T12:00:00.000Z`}});
export const FACTS=[
  fact('fact_owner','owner','Mira owns this private workspace.','2026-01-01',true),
  fact('fact_budget','atlas-budget','Atlas approved project budget is EUR 4800.','2026-04-01'),
  fact('fact_deadline','atlas-deadline','Atlas launch deadline is 2026-11-19.','2026-04-02'),
  fact('fact_font','website-typeface','Use Sora as the website font and typeface.','2026-05-01'),
  {...fact('fact_city','home-city','Current home city is Warsaw; the old London address is outdated.','2026-10-15'),supersedes:{revision:'public-fixture-old-city',updatedAt:'2025-01-01T12:00:00.000Z'}},
  fact('fact_food','meal-preference','Prefer vegetarian meals without mushrooms.','2026-06-01'),
  fact('fact_garden','garden','Water garden tomatoes each morning.','2026-10-28'),
  fact('fact_golf','weekend','Golf practice is Saturday afternoon.','2026-10-27'),
  fact('fact_kitchen','kitchen','The kettle is on the left shelf.','2026-10-26'),
];
export const NOTES=[
  {id:'imports/old-profile.md',date:'2025-01-01',stale:true,text:'# Imported profile\nAn old imported report says the home city is London. This is outdated; it predates the owner correction.'},
  {id:'projects/atlas.md',date:'2026-04-02',text:'# Atlas project\nAtlas project budget is EUR 4800. The approved cost includes launch work. Required launch deadline is 2026-11-19.'},
  {id:'design/website.md',date:'2026-05-01',text:'# Website typography\nUse Sora as the website font and typeface. Keep headings readable.'},
  {id:'home/meals.md',date:'2026-06-01',text:'# Vegetarian meals\nPrepare vegetarian meals without mushrooms. Lentil soup is an option.'},
  {id:'people/current-profile.md',date:'2026-10-15',text:'# Current home city\nThe owner corrected their home city from London to Warsaw on 2026-10-15. Current commute planning starts in Warsaw.'},
  {id:'home/garden.md',date:'2026-10-28',text:'# Tomato garden\nWater garden tomatoes each morning; keep soil evenly moist.'},
];
export const HISTORY=[
  {id:'history_city_old',date:'2025-01-01',stale:true,text:'My home city is London.'},
  {id:'history_budget',date:'2026-04-01',text:'Atlas approved project budget is EUR 4800.'},
  {id:'history_deadline',date:'2026-04-02',text:'Atlas required launch deadline is 2026-11-19.'},
  {id:'history_font',date:'2026-05-01',text:'Use Sora as the website font and typeface.'},
  {id:'history_food',date:'2026-06-01',text:'Prefer vegetarian meals without mushrooms.'},
  {id:'history_city_current',date:'2026-10-15',text:'Correction: my current home city is Warsaw. The old London preference is superseded.'},
  {id:'history_garden',date:'2026-10-28',text:'Water garden tomatoes every morning.'},
  {id:'history_private',date:'2026-10-28',private:true,text:'PRIVATE-RETRIEVAL-913 is a canary from another person’s Telegram lane.'},
];
const labels=(facts,notes,history)=>({facts:['fact_owner',...facts],notes,history});
export const QUERIES=[
  {id:'budget-exact',query:'Atlas approved project budget',relevant:labels(['fact_budget'],['projects/atlas.md'],['history_budget'])},
  {id:'budget-paraphrase',query:'What does the Atlas project cost?',relevant:labels(['fact_budget'],['projects/atlas.md'],['history_budget'])},
  {id:'budget-ukrainian',query:'Який бюджет Atlas?',relevant:labels(['fact_budget'],['projects/atlas.md'],['history_budget'])},
  {id:'budget-polish',query:'Jaki jest koszt Atlas?',relevant:labels(['fact_budget'],['projects/atlas.md'],['history_budget'])},
  {id:'deadline-paraphrase',query:'When is Atlas due for launch?',relevant:labels(['fact_deadline'],['projects/atlas.md'],['history_deadline'])},
  {id:'font-paraphrase',query:'Which typeface should the website use?',relevant:labels(['fact_font'],['design/website.md'],['history_font'])},
  {id:'short-followup',query:'Yes, go ahead.',previous:'Prepare the approved Atlas project budget.',relevant:labels(['fact_budget'],['projects/atlas.md'],['history_budget'])},
  {id:'city-correction',query:'What is my current home city for the commute?',relevant:labels(['fact_city'],['people/current-profile.md'],['history_city_current']),stale:{facts:[],notes:['imports/old-profile.md'],history:['history_city_old']}},
  {id:'meal-preference',query:'How do I prepare vegetarian meals?',relevant:labels(['fact_food'],['home/meals.md'],['history_food'])},
  {id:'recent-garden',query:'Water the garden tomatoes',relevant:labels(['fact_garden'],['home/garden.md'],['history_garden'])},
  {id:'private-lane',query:'Find PRIVATE-RETRIEVAL-913 from the Telegram person.',sources:['history'],relevant:{history:[]},excluded:{history:['history_private']}},
  {id:'absent-topic',query:'Quantum insurance banana',relevant:{facts:['fact_owner'],notes:[],history:[]}},
];
