/**
 * Curated Hebrew/English → emoji lexicon for the rule-based engine.
 *
 * Each concept lists base forms. The matcher additionally strips Hebrew one-letter
 * prefixes (ו ה ב ל מ ש כ) and common plural/feminine suffixes, and applies light
 * English stemming, so inflections need not all be listed. Multi-word phrases are
 * matched before single words (longest match wins).
 *
 * `emojis[0]` is the default; later entries are alternatives used by "regenerate"
 * (the `variant` parameter). `expressive` is used by the expressive style.
 * `weight` orders concepts when a style allows only a few emojis (higher first).
 */
export interface Concept {
  id: string;
  emojis: string[];
  expressive?: string;
  he: string[];
  en: string[];
  weight: number;
}

export const CONCEPTS: Concept[] = [
  // Greetings & social
  { id: 'hello', emojis: ['👋', '🙋'], expressive: '👋😄', he: ['שלום', 'היי', 'הי', 'אהלן', 'הלו'], en: ['hello', 'hi', 'hey', 'greetings'], weight: 8 },
  { id: 'goodbye', emojis: ['👋', '🫡'], expressive: '👋🙂', he: ['להתראות', 'ביי', 'נתראה', 'נתראה מחר'], en: ['goodbye', 'bye', 'farewell'], weight: 7 },
  { id: 'thanks', emojis: ['🙏', '💐'], expressive: '🙏✨', he: ['תודה', 'תודה רבה', 'מודה', 'מודים', 'תודות'], en: ['thanks', 'thank you', 'thank', 'grateful', 'appreciate'], weight: 8 },
  { id: 'please', emojis: ['🙏', '🥺'], he: ['בבקשה', 'אנא'], en: ['please'], weight: 5 },
  { id: 'sorry', emojis: ['😔', '🙇'], he: ['סליחה', 'מצטער', 'מצטערת', 'מתנצל', 'מתנצלת'], en: ['sorry', 'apologize', 'apologies'], weight: 7 },
  { id: 'welcome', emojis: ['🤗', '🎊'], he: ['ברוך הבא', 'ברוכה הבאה', 'ברוכים הבאים'], en: ['welcome'], weight: 7 },
  { id: 'good_morning', emojis: ['🌅', '☀️'], he: ['בוקר טוב'], en: ['good morning'], weight: 8 },
  { id: 'good_night', emojis: ['🌙', '😴'], he: ['לילה טוב'], en: ['good night', 'goodnight'], weight: 8 },
  { id: 'congrats', emojis: ['🎉', '👏'], expressive: '🎉🥳', he: ['מזל טוב', 'כל הכבוד', 'ברכות', 'מברך', 'מברכת'], en: ['congratulations', 'congrats', 'well done', 'bravo'], weight: 9 },
  { id: 'birthday', emojis: ['🎂', '🎈'], expressive: '🎂🎉', he: ['יום הולדת', 'יומולדת'], en: ['birthday'], weight: 9 },
  { id: 'see_you', emojis: ['🤗', '😊'], he: ['לראות אותך', 'לראות אותכם', 'לפגוש אותך', 'לפגוש'], en: ['see you', 'meet you'], weight: 6 },
  { id: 'love', emojis: ['❤️', '🥰'], expressive: '❤️😍', he: ['אוהב', 'אוהבת', 'אוהבים', 'אהבה', 'אוהבות'], en: ['love', 'loves', 'loved'], weight: 8 },

  // Feelings
  { id: 'happy', emojis: ['😊', '😄'], expressive: '😄✨', he: ['שמח', 'שמחה', 'שמחים', 'שמחות', 'מאושר', 'מאושרת', 'כיף'], en: ['happy', 'glad', 'joy', 'fun', 'delighted'], weight: 7 },
  { id: 'sad', emojis: ['😢', '😞'], expressive: '😢💔', he: ['עצוב', 'עצובה', 'עצובים', 'עצב', 'בוכה'], en: ['sad', 'unhappy', 'cry', 'crying'], weight: 7 },
  { id: 'angry', emojis: ['😠', '😤'], he: ['כועס', 'כועסת', 'עצבני', 'עצבנית', 'כעס'], en: ['angry', 'mad', 'annoyed'], weight: 7 },
  { id: 'tired', emojis: ['😴', '🥱'], he: ['עייף', 'עייפה', 'עייפים', 'מותש'], en: ['tired', 'sleepy', 'exhausted'], weight: 6 },
  { id: 'scared', emojis: ['😨', '😱'], he: ['מפחד', 'מפחדת', 'פחד', 'מפוחד'], en: ['scared', 'afraid', 'fear'], weight: 6 },
  { id: 'excited', emojis: ['🤩', '🥳'], he: ['מתרגש', 'מתרגשת', 'נרגש', 'נרגשת', 'התרגשות'], en: ['excited', 'thrilled'], weight: 7 },
  { id: 'worried', emojis: ['😟', '😬'], he: ['דואג', 'דואגת', 'מודאג', 'דאגה'], en: ['worried', 'worry', 'anxious'], weight: 6 },
  { id: 'laugh', emojis: ['😂', '🤣'], he: ['צוחק', 'צוחקת', 'מצחיק', 'צחוק', 'חחח', 'חחחח'], en: ['laugh', 'funny', 'lol', 'haha'], weight: 6 },
  { id: 'surprised', emojis: ['😮', '😲'], he: ['מופתע', 'מופתעת', 'הפתעה', 'וואו'], en: ['surprised', 'surprise', 'wow'], weight: 6 },
  { id: 'calm', emojis: ['😌', '🧘'], he: ['רגוע', 'רגועה', 'שקט'], en: ['calm', 'relaxed', 'quiet'], weight: 4 },
  { id: 'sick', emojis: ['🤒', '🤧'], he: ['חולה', 'חולים', 'חום', 'מצונן', 'מצוננת'], en: ['sick', 'ill', 'fever', 'flu'], weight: 7 },
  { id: 'pain', emojis: ['🤕', '😣'], he: ['כואב', 'כואבת', 'כאב', 'כאבים'], en: ['pain', 'hurt', 'hurts', 'ache'], weight: 7 },
  { id: 'good', emojis: ['👍', '👌'], he: ['טוב', 'טובה', 'טובים', 'מעולה', 'מצוין', 'סבבה', 'בסדר'], en: ['good', 'great', 'ok', 'okay', 'fine', 'excellent'], weight: 4 },
  { id: 'bad', emojis: ['👎', '😕'], he: ['רע', 'רעה', 'גרוע', 'גרועה'], en: ['bad', 'terrible', 'awful'], weight: 4 },
  { id: 'beautiful', emojis: ['😍', '🌸'], he: ['יפה', 'יפים', 'יפות', 'מהמם', 'מהממת'], en: ['beautiful', 'pretty', 'lovely', 'gorgeous'], weight: 5 },

  // Needs & help
  { id: 'help', emojis: ['🆘', '🙋'], he: ['עזרה', 'לעזור', 'עוזר', 'עוזרת', 'הצילו'], en: ['help', 'assist', 'support'], weight: 8 },
  { id: 'need', emojis: ['🙋', '☝️'], he: ['צריך', 'צריכה', 'צריכים', 'זקוק', 'זקוקה'], en: ['need', 'needs'], weight: 3 },
  { id: 'question', emojis: ['❓', '🤔'], he: ['שאלה', 'שאלות', 'למה', 'מדוע', 'איך'], en: ['question', 'why', 'how'], weight: 4 },
  { id: 'where', emojis: ['📍', '🗺️'], he: ['איפה', 'היכן', 'לאן'], en: ['where'], weight: 4 },
  { id: 'think', emojis: ['🤔', '💭'], he: ['חושב', 'חושבת', 'חושבים', 'מחשבה'], en: ['think', 'thinking', 'thought'], weight: 4 },
  { id: 'yes', emojis: ['✅', '👍'], he: ['כן', 'בטח', 'בהחלט'], en: ['yes', 'sure', 'definitely'], weight: 4 },
  { id: 'wait', emojis: ['⏳', '✋'], he: ['לחכות', 'מחכה', 'חכה', 'חכי', 'רגע'], en: ['wait', 'waiting', 'moment'], weight: 4 },
  { id: 'emergency', emojis: ['🚨', '🆘'], he: ['חירום', 'דחוף', 'מסוכן', 'סכנה'], en: ['emergency', 'urgent', 'danger'], weight: 9 },
  { id: 'doctor', emojis: ['🧑‍⚕️', '🩺'], he: ['רופא', 'רופאה', 'רופאים', 'אחות', 'מרפאה'], en: ['doctor', 'nurse', 'clinic'], weight: 7 },
  { id: 'hospital', emojis: ['🏥'], he: ['בית חולים', 'בית החולים'], en: ['hospital'], weight: 8 },
  { id: 'medicine', emojis: ['💊'], he: ['תרופה', 'תרופות'], en: ['medicine', 'pill', 'pills', 'medication'], weight: 6 },
  { id: 'phone', emojis: ['📞', '📱'], he: ['טלפון', 'להתקשר', 'מתקשר', 'שיחה', 'פלאפון'], en: ['phone', 'call', 'calling'], weight: 5 },
  { id: 'message', emojis: ['💬', '✉️'], he: ['הודעה', 'הודעות', 'לכתוב', 'כותב', 'כותבת'], en: ['message', 'text', 'write', 'writing'], weight: 4 },
  { id: 'money', emojis: ['💰', '💵'], he: ['כסף', 'לשלם', 'משלם', 'תשלום', 'מחיר'], en: ['money', 'pay', 'payment', 'price', 'cost'], weight: 5 },

  // Time
  { id: 'today', emojis: ['📅'], he: ['היום'], en: ['today'], weight: 3 },
  { id: 'tomorrow', emojis: ['📅', '➡️'], he: ['מחר'], en: ['tomorrow'], weight: 3 },
  { id: 'time', emojis: ['⏰', '🕒'], he: ['שעה', 'שעות', 'זמן', 'דקה', 'דקות'], en: ['time', 'hour', 'hours', 'minute', 'minutes', 'clock'], weight: 3 },
  { id: 'morning', emojis: ['🌅'], he: ['בוקר'], en: ['morning'], weight: 3 },
  { id: 'night', emojis: ['🌙'], he: ['לילה', 'ערב'], en: ['night', 'evening', 'tonight'], weight: 3 },
  { id: 'weekend', emojis: ['🗓️', '😎'], he: ['סופש', 'סוף שבוע'], en: ['weekend'], weight: 4 },
  { id: 'shabbat', emojis: ['🕯️', '🍞'], he: ['שבת', 'שבת שלום'], en: ['shabbat', 'sabbath'], weight: 8 },
  { id: 'holiday', emojis: ['🎊', '✨'], he: ['חג', 'חג שמח', 'חגים'], en: ['holiday', 'holidays'], weight: 7 },
  { id: 'late', emojis: ['⏰', '🏃'], he: ['מאחר', 'מאחרת', 'איחור', 'מאוחר'], en: ['late'], weight: 5 },

  // Places & transport
  { id: 'home', emojis: ['🏠', '🏡'], he: ['בית', 'הביתה', 'דירה'], en: ['home', 'house'], weight: 5 },
  { id: 'school', emojis: ['🏫', '🎒'], he: ['בית ספר', 'ביה"ס', 'כיתה', 'גן'], en: ['school', 'class', 'kindergarten'], weight: 6 },
  { id: 'work', emojis: ['💼', '🏢'], he: ['עבודה', 'עובד', 'עובדת', 'משרד'], en: ['work', 'job', 'office', 'working'], weight: 5 },
  { id: 'bus', emojis: ['🚌'], he: ['אוטובוס', 'אוטובוסים', 'תחנת האוטובוס', 'תחנה'], en: ['bus', 'station', 'stop'], weight: 6 },
  { id: 'car', emojis: ['🚗', '🚙'], he: ['רכב', 'מכונית', 'אוטו', 'נוסע', 'נוסעת', 'נסיעה'], en: ['car', 'drive', 'driving', 'ride'], weight: 5 },
  { id: 'train', emojis: ['🚆'], he: ['רכבת'], en: ['train'], weight: 6 },
  { id: 'plane', emojis: ['✈️'], he: ['טיסה', 'מטוס', 'שדה תעופה', 'טס', 'טסה'], en: ['flight', 'plane', 'airport', 'fly'], weight: 6 },
  { id: 'trip', emojis: ['🧳', '🗺️'], he: ['טיול', 'חופשה', 'מטיילים'], en: ['trip', 'travel', 'vacation'], weight: 6 },
  { id: 'beach', emojis: ['🏖️', '🌊'], he: ['ים', 'חוף'], en: ['beach', 'sea', 'ocean'], weight: 6 },
  { id: 'shop', emojis: ['🛒', '🛍️'], he: ['קניות', 'סופר', 'חנות', 'לקנות', 'קונה'], en: ['shopping', 'shop', 'store', 'buy', 'supermarket'], weight: 5 },

  // Food & drink
  { id: 'food', emojis: ['🍽️', '😋'], he: ['אוכל', 'לאכול', 'אוכלים', 'ארוחה', 'רעב', 'רעבה'], en: ['food', 'eat', 'eating', 'meal', 'hungry'], weight: 5 },
  { id: 'coffee', emojis: ['☕'], he: ['קפה'], en: ['coffee'], weight: 6 },
  { id: 'tea', emojis: ['🍵'], he: ['תה'], en: ['tea'], weight: 6 },
  { id: 'water', emojis: ['💧', '🚰'], he: ['מים', 'צמא', 'צמאה', 'לשתות'], en: ['water', 'thirsty', 'drink'], weight: 5 },
  { id: 'pizza', emojis: ['🍕'], he: ['פיצה'], en: ['pizza'], weight: 6 },
  { id: 'cake', emojis: ['🍰', '🧁'], he: ['עוגה', 'עוגות', 'עוגיות'], en: ['cake', 'cookies', 'dessert'], weight: 6 },
  { id: 'breakfast', emojis: ['🥐', '🍳'], he: ['ארוחת בוקר'], en: ['breakfast'], weight: 6 },
  { id: 'fruit', emojis: ['🍎', '🍉'], he: ['פרי', 'פירות', 'תפוח', 'אבטיח'], en: ['fruit', 'apple', 'watermelon'], weight: 5 },

  // People & family
  { id: 'family', emojis: ['👨‍👩‍👧‍👦', '🏡'], he: ['משפחה', 'משפחות'], en: ['family'], weight: 6 },
  { id: 'friend', emojis: ['🤝', '🧑‍🤝‍🧑'], he: ['חבר', 'חברה', 'חברים', 'חברות'], en: ['friend', 'friends', 'buddy'], weight: 5 },
  { id: 'baby', emojis: ['👶', '🍼'], he: ['תינוק', 'תינוקת', 'תינוקות'], en: ['baby'], weight: 6 },
  { id: 'child', emojis: ['🧒', '👧'], he: ['ילד', 'ילדה', 'ילדים', 'ילדות'], en: ['child', 'kid', 'kids', 'children'], weight: 5 },
  { id: 'mother', emojis: ['👩', '🤱'], he: ['אמא', 'אימא'], en: ['mom', 'mother', 'mum'], weight: 5 },
  { id: 'father', emojis: ['👨'], he: ['אבא'], en: ['dad', 'father'], weight: 5 },
  { id: 'grandparent', emojis: ['👵', '👴'], he: ['סבתא', 'סבא'], en: ['grandma', 'grandpa', 'grandmother', 'grandfather'], weight: 5 },
  { id: 'teacher', emojis: ['🧑‍🏫'], he: ['מורה', 'מורים', 'מורות'], en: ['teacher', 'teachers'], weight: 5 },

  // Nature & weather
  { id: 'sun', emojis: ['☀️', '🌞'], he: ['שמש', 'שמשי', 'חם', 'חמה'], en: ['sun', 'sunny', 'hot'], weight: 4 },
  { id: 'rain', emojis: ['🌧️', '☔'], he: ['גשם', 'גשום', 'יורד גשם'], en: ['rain', 'rainy', 'raining'], weight: 5 },
  { id: 'cold', emojis: ['🥶', '❄️'], he: ['קר', 'קרה', 'שלג', 'קור'], en: ['cold', 'snow', 'freezing'], weight: 5 },
  { id: 'flower', emojis: ['🌷', '💐'], he: ['פרח', 'פרחים', 'זר פרחים'], en: ['flower', 'flowers', 'bouquet'], weight: 5 },
  { id: 'tree', emojis: ['🌳'], he: ['עץ', 'עצים'], en: ['tree', 'trees'], weight: 4 },
  { id: 'dog', emojis: ['🐶', '🐕'], he: ['כלב', 'כלבה', 'כלבים'], en: ['dog', 'dogs', 'puppy'], weight: 6 },
  { id: 'cat', emojis: ['🐱', '🐈'], he: ['חתול', 'חתולה', 'חתולים'], en: ['cat', 'cats', 'kitten'], weight: 6 },

  // Activities & things
  { id: 'music', emojis: ['🎵', '🎶'], he: ['מוזיקה', 'שיר', 'שירים', 'לשיר'], en: ['music', 'song', 'sing', 'singing'], weight: 5 },
  { id: 'book', emojis: ['📚', '📖'], he: ['ספר', 'ספרים', 'לקרוא', 'קורא', 'קוראת'], en: ['book', 'books', 'read', 'reading'], weight: 5 },
  { id: 'study', emojis: ['📝', '🎓'], he: ['ללמוד', 'לומד', 'לומדת', 'מבחן', 'שיעורים'], en: ['study', 'studying', 'exam', 'test', 'homework'], weight: 5 },
  { id: 'sport', emojis: ['⚽', '🏃'], he: ['כדורגל', 'ספורט', 'לרוץ', 'ריצה', 'אימון'], en: ['football', 'soccer', 'sport', 'run', 'running', 'workout'], weight: 5 },
  { id: 'sleep', emojis: ['😴', '🛏️'], he: ['לישון', 'שינה', 'נרדם', 'נרדמת'], en: ['sleep', 'sleeping', 'bed'], weight: 5 },
  { id: 'gift', emojis: ['🎁'], he: ['מתנה', 'מתנות'], en: ['gift', 'present'], weight: 6 },
  { id: 'party', emojis: ['🎉', '🥳'], he: ['מסיבה', 'חגיגה', 'לחגוג'], en: ['party', 'celebrate', 'celebration'], weight: 7 },
  { id: 'photo', emojis: ['📸'], he: ['תמונה', 'תמונות', 'צילום'], en: ['photo', 'picture', 'pictures'], weight: 5 },
  { id: 'computer', emojis: ['💻'], he: ['מחשב', 'לפטופ'], en: ['computer', 'laptop'], weight: 5 },
  { id: 'idea', emojis: ['💡'], he: ['רעיון', 'רעיונות'], en: ['idea', 'ideas'], weight: 6 },
  { id: 'success', emojis: ['🏆', '💪'], he: ['הצלחה', 'הצלחתי', 'ניצחון', 'בהצלחה'], en: ['success', 'win', 'won', 'good luck'], weight: 7 },
  { id: 'strong', emojis: ['💪'], he: ['חזק', 'חזקה', 'כוח'], en: ['strong', 'strength'], weight: 5 },
  { id: 'peace', emojis: ['🕊️', '☮️'], he: ['שלום עולמי', 'שלווה'], en: ['peace'], weight: 5 },
  { id: 'fire', emojis: ['🔥'], he: ['אש', 'שריפה', 'לוהט'], en: ['fire', 'lit'], weight: 5 },
  { id: 'star', emojis: ['⭐', '🌟'], he: ['כוכב', 'כוכבים'], en: ['star', 'stars'], weight: 4 },
  { id: 'heart', emojis: ['❤️'], he: ['לב', 'לבבות'], en: ['heart', 'hearts'], weight: 6 },
  { id: 'sign_language', emojis: ['🤟', '🧏'], he: ['שפת סימנים', 'חירש', 'חירשת', 'חירשים', 'כבד שמיעה', 'כבדת שמיעה'], en: ['sign language', 'deaf', 'hard of hearing'], weight: 8 },
];
