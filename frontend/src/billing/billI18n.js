// Bill & document language (Settings → Business & Localization → General → "Bills print in").
//
//   EN         English labels (default)
//   LOCAL      labels in the business language only, e.g. Arabic
//   BILINGUAL  English + the business language, e.g. "Grand Total / الإجمالي الكلي"
//
// Only the FIXED wording of a bill is translated — titles, column headings, totals, captions.
// Customer names, item names, addresses and notes print exactly as they were entered. Lookup is
// by the English text (case-insensitive), so a template label still at its default wording is
// translated; a label someone typed differently prints as typed.
//
// Pure module: the bill renderers import it and also run under plain `node --test`.
import { getBusinessPrefs } from '../utils/localeFormat.js';

export const BILL_LANGUAGE_MODES = ['EN', 'LOCAL', 'BILINGUAL'];
const RTL = new Set(['ar', 'ur']);

// English → [Arabic, Hindi, Malayalam, Tamil]
const LANGS = ['ar', 'hi', 'ml', 'ta'];
const ROWS = [
  // document titles
  ['Invoice', 'فاتورة', 'बीजक', 'ഇൻവോയ്സ്', 'விலைப்பட்டியல்'],
  ['Tax Invoice', 'فاتورة ضريبية', 'कर बीजक', 'നികുതി ഇൻവോയ്സ്', 'வரி விலைப்பட்டியல்'],
  ['Wholesale Tax Invoice', 'فاتورة ضريبية للجملة', 'थोक कर बीजक', 'മൊത്തവ്യാപാര നികുതി ഇൻവോയ്സ്', 'மொத்த வரி விலைப்பட்டியல்'],
  ['Order / Job Slip', 'طلب / بطاقة عمل', 'ऑर्डर / जॉब स्लिप', 'ഓർഡർ / ജോബ് സ്ലിപ്പ്', 'ஆர்டர் / வேலைச் சீட்டு'],
  ['Purchase Entry / Goods Receipt', 'قيد شراء / إيصال استلام بضائع', 'खरीद प्रविष्टि / माल रसीद', 'പർച്ചേസ് എൻട്രി / ചരക്ക് രസീത്', 'கொள்முதல் பதிவு / சரக்கு ரசீது'],
  ['Sales Return / Credit Note', 'مرتجع مبيعات / إشعار دائن', 'बिक्री वापसी / क्रेडिट नोट', 'സെയിൽസ് റിട്ടേൺ / ക്രെഡിറ്റ് നോട്ട്', 'விற்பனை திருப்பம் / வரவுக் குறிப்பு'],
  ['Purchase Return / Debit Note', 'مرتجع مشتريات / إشعار مدين', 'खरीद वापसी / डेबिट नोट', 'പർച്ചേസ് റിട്ടേൺ / ഡെബിറ്റ് നോട്ട്', 'கொள்முதல் திருப்பம் / பற்றுக் குறிப்பு'],
  ['Quotation / Estimate', 'عرض سعر / تقدير', 'कोटेशन / अनुमान', 'ക്വട്ടേഷൻ / എസ്റ്റിമേറ്റ്', 'விலைப்புள்ளி / மதிப்பீடு'],
  ['Quotation', 'عرض سعر', 'कोटेशन', 'ക്വട്ടേഷൻ', 'விலைப்புள்ளி'],
  ['Payment Receipt', 'إيصال دفع', 'भुगतान रसीद', 'പേയ്മെന്റ് രസീത്', 'கட்டண ரசீது'],
  ['Receipt', 'إيصال', 'रसीद', 'രസീത്', 'ரசீது'],
  ['Bill', 'فاتورة', 'बिल', 'ബിൽ', 'பில்'],
  // parties
  ['Bill To', 'فاتورة إلى', 'बिल प्राप्तकर्ता', 'ബിൽ ടു', 'பில் பெறுநர்'],
  ['Billed To (Wholesale Buyer)', 'فاتورة إلى (مشتري الجملة)', 'बिल प्राप्तकर्ता (थोक क्रेता)', 'ബിൽ ടു (മൊത്ത വാങ്ങുന്നയാൾ)', 'பில் பெறுநர் (மொத்த வாங்குபவர்)'],
  ['Ship To', 'الشحن إلى', 'माल भेजें', 'ഷിപ്പ് ടു', 'அனுப்ப வேண்டிய முகவரி'],
  ['Supplier', 'المورد', 'आपूर्तिकर्ता', 'വിതരണക്കാരൻ', 'விநியோகஸ்தர்'],
  ['Customer', 'العميل', 'ग्राहक', 'ഉപഭോക്താവ്', 'வாடிக்கையாளர்'],
  ['Received From', 'استلمنا من', 'से प्राप्त', 'ഇവരിൽ നിന്ന് ലഭിച്ചു', 'பெறப்பட்டது'],
  ['Prepared For', 'أُعد لـ', 'के लिए तैयार', 'ആർക്കുവേണ്ടി തയ്യാറാക്കിയത്', 'யாருக்காக தயாரிக்கப்பட்டது'],
  ['Phone', 'الهاتف', 'फ़ोन', 'ഫോൺ', 'தொலைபேசி'],
  ['Ph', 'هاتف', 'फ़ोन', 'ഫോൺ', 'தொ.பே'],
  ['Mobile', 'الجوال', 'मोबाइल', 'മൊബൈൽ', 'கைபேசி'],
  ['Email', 'البريد الإلكتروني', 'ईमेल', 'ഇമെയിൽ', 'மின்னஞ்சல்'],
  ['Address', 'العنوان', 'पता', 'വിലാസം', 'முகவரி'],
  // document details
  ['Invoice No', 'رقم الفاتورة', 'बीजक सं.', 'ഇൻവോയ്സ് നം.', 'விலைப்பட்டியல் எண்'],
  ['Order No', 'رقم الطلب', 'ऑर्डर सं.', 'ഓർഡർ നം.', 'ஆர்டர் எண்'],
  ['Date', 'التاريخ', 'दिनांक', 'തീയതി', 'தேதி'],
  ['Due Date', 'تاريخ الاستحقاق', 'देय तिथि', 'അവസാന തീയതി', 'செலுத்த வேண்டிய தேதி'],
  ['Delivery Date', 'تاريخ التسليم', 'डिलीवरी तिथि', 'ഡെലിവറി തീയതി', 'டெலிவரி தேதி'],
  ['Payment Status', 'حالة الدفع', 'भुगतान स्थिति', 'പേയ്മെന്റ് നില', 'கட்டண நிலை'],
  ['Salesperson', 'مندوب المبيعات', 'विक्रेता', 'സെയിൽസ്പേഴ്സൺ', 'விற்பனையாளர்'],
  ['Branch', 'الفرع', 'शाखा', 'ശാഖ', 'கிளை'],
  ['Ref', 'المرجع', 'संदर्भ', 'റഫ.', 'குறிப்பு எண்'],
  ['Status', 'الحالة', 'स्थिति', 'നില', 'நிலை'],
  // item columns
  ['#', 'م', 'क्र.', 'ക്രമ നം.', 'வ.எண்'],
  ['Sl', 'م', 'क्र.', 'ക്രമ നം.', 'வ.எண்'],
  ['Sl No', 'م', 'क्र.', 'ക്രമ നം.', 'வ.எண்'],
  ['S.No', 'م', 'क्र.', 'ക്രമ നം.', 'வ.எண்'],
  ['Item', 'الصنف', 'वस्तु', 'ഇനം', 'பொருள்'],
  ['Item / Description', 'الصنف / الوصف', 'वस्तु / विवरण', 'ഇനം / വിവരണം', 'பொருள் / விவரம்'],
  ['Product', 'المنتج', 'उत्पाद', 'ഉൽപ്പന്നം', 'தயாரிப்பு'],
  ['Description', 'الوصف', 'विवरण', 'വിവരണം', 'விவரம்'],
  ['Brand', 'العلامة التجارية', 'ब्रांड', 'ബ്രാൻഡ്', 'பிராண்ட்'],
  ['SKU', 'الرمز', 'कोड', 'കോഡ്', 'குறியீடு'],
  ['SKU / Code', 'الرمز', 'कोड', 'കോഡ്', 'குறியீடு'],
  ['Barcode', 'الباركود', 'बारकोड', 'ബാർകോഡ്', 'பார்கோடு'],
  ['Variant', 'النوع', 'प्रकार', 'വേരിയന്റ്', 'வகை'],
  ['Size', 'المقاس', 'आकार', 'വലിപ്പം', 'அளவு'],
  ['Colour', 'اللون', 'रंग', 'നിറം', 'நிறம்'],
  ['Color', 'اللون', 'रंग', 'നിറം', 'நிறம்'],
  ['Power (Rx)', 'قوة العدسة', 'पावर (Rx)', 'പവർ (Rx)', 'பவர் (Rx)'],
  ['Batch', 'الدفعة', 'बैच', 'ബാച്ച്', 'தொகுதி'],
  ['Expiry', 'الانتهاء', 'समाप्ति', 'കാലാവധി', 'காலாவதி'],
  ['Qty', 'الكمية', 'मात्रा', 'എണ്ണം', 'எண்ணிக்கை'],
  ['Free', 'مجاني', 'मुफ़्त', 'സൗജന്യം', 'இலவசம்'],
  ['Unit', 'الوحدة', 'इकाई', 'യൂണിറ്റ്', 'அலகு'],
  ['MRP', 'السعر الأقصى', 'एमआरपी', 'എംആർപി', 'அதிகபட்ச விலை'],
  ['Rate', 'السعر', 'दर', 'നിരക്ക്', 'விலை'],
  ['Price', 'السعر', 'मूल्य', 'വില', 'விலை'],
  ['Discount', 'الخصم', 'छूट', 'കിഴിവ്', 'தள்ளுபடி'],
  ['Disc', 'الخصم', 'छूट', 'കിഴിവ്', 'தள்ளுபடி'],
  ['Disc %', 'الخصم %', 'छूट %', 'കിഴിവ് %', 'தள்ளுபடி %'],
  ['GST %', 'الضريبة %', 'जीएसटी %', 'ജിഎസ്ടി %', 'ஜிஎஸ்டி %'],
  ['GST Amt', 'مبلغ الضريبة', 'जीएसटी राशि', 'ജിഎസ്ടി തുക', 'ஜிஎஸ்டி தொகை'],
  ['Tax', 'الضريبة', 'कर', 'നികുതി', 'வரி'],
  ['Amount', 'المبلغ', 'राशि', 'തുക', 'தொகை'],
  ['Amt', 'المبلغ', 'राशि', 'തുക', 'தொகை'],
  ['Total', 'الإجمالي', 'कुल', 'ആകെ', 'மொத்தம்'],
  ['Other', 'أخرى', 'अन्य', 'മറ്റുള്ളവ', 'இதர'],
  ['No items', 'لا توجد أصناف', 'कोई वस्तु नहीं', 'ഇനങ്ങളൊന്നുമില്ല', 'பொருட்கள் இல்லை'],
  // totals
  ['Subtotal', 'المجموع الفرعي', 'उप-योग', 'ഉപമൊത്തം', 'கூட்டுத்தொகை'],
  ['Additional Discount', 'خصم إضافي', 'अतिरिक्त छूट', 'അധിക കിഴിവ്', 'கூடுதல் தள்ளுபடி'],
  ['Shipping / Delivery', 'الشحن / التوصيل', 'शिपिंग / डिलीवरी', 'ഷിപ്പിംഗ് / ഡെലിവറി', 'அனுப்புதல் / டெலிவரி'],
  ['Other Charges', 'رسوم أخرى', 'अन्य शुल्क', 'മറ്റ് ചാർജുകൾ', 'இதர கட்டணங்கள்'],
  ['Round Off', 'التقريب', 'पूर्णांकन', 'റൗണ്ട് ഓഫ്', 'முழுமையாக்கல்'],
  ['Grand Total', 'الإجمالي الكلي', 'कुल योग', 'ആകെ തുക', 'மொத்தத் தொகை'],
  ['Net Amount', 'صافي المبلغ', 'शुद्ध राशि', 'നെറ്റ് തുക', 'நிகரத் தொகை'],
  ['Taxable Amount', 'المبلغ الخاضع للضريبة', 'कर योग्य राशि', 'നികുതി ബാധകമായ തുക', 'வரிக்குட்பட்ட தொகை'],
  ['Total Tax', 'إجمالي الضريبة', 'कुल कर', 'ആകെ നികുതി', 'மொத்த வரி'],
  ['Paid', 'المدفوع', 'भुगतान किया', 'അടച്ചത്', 'செலுத்தியது'],
  ['Paid Amount', 'المبلغ المدفوع', 'भुगतान राशि', 'അടച്ച തുക', 'செலுத்திய தொகை'],
  ['Amount Paid', 'المبلغ المدفوع', 'भुगतान राशि', 'അടച്ച തുക', 'செலுத்திய தொகை'],
  ['Balance', 'الرصيد', 'शेष', 'ബാക്കി', 'நிலுவை'],
  ['Balance Amount', 'المبلغ المتبقي', 'शेष राशि', 'ബാക്കി തുക', 'நிலுவைத் தொகை'],
  ['Balance Due', 'المبلغ المستحق', 'देय शेष', 'നൽകാനുള്ള ബാക്കി', 'செலுத்த வேண்டிய நிலுவை'],
  ['Outstanding Balance', 'الرصيد المستحق', 'बकाया राशि', 'കുടിശ്ശിക', 'நிலுவையில் உள்ள தொகை'],
  ['Refund Amount', 'مبلغ الاسترداد', 'वापसी राशि', 'റീഫണ്ട് തുക', 'திருப்பித் தரும் தொகை'],
  ['Amount in Words', 'المبلغ كتابةً', 'शब्दों में राशि', 'തുക അക്ഷരത്തിൽ', 'தொகை எழுத்தில்'],
  // payment
  ['Payment', 'الدفع', 'भुगतान', 'പേയ്മെന്റ്', 'கட்டணம்'],
  ['Payment Method', 'طريقة الدفع', 'भुगतान का तरीका', 'പേയ്മെന്റ് രീതി', 'கட்டண முறை'],
  ['Payment Details', 'تفاصيل الدفع', 'भुगतान विवरण', 'പേയ്മെന്റ് വിവരങ്ങൾ', 'கட்டண விவரங்கள்'],
  ['Bank', 'البنك', 'बैंक', 'ബാങ്ക്', 'வங்கி'],
  ['Method', 'الطريقة', 'तरीका', 'രീതി', 'முறை'],
  ['Split', 'التوزيع', 'विभाजन', 'വിഭജനം', 'பிரிப்பு'],
  ['Reference', 'المرجع', 'संदर्भ', 'റഫറൻസ്', 'குறிப்பு எண்'],
  // footer
  ['Notes', 'ملاحظات', 'टिप्पणियाँ', 'കുറിപ്പുകൾ', 'குறிப்புகள்'],
  ['Terms & Conditions', 'الشروط والأحكام', 'नियम और शर्तें', 'നിബന്ധനകളും വ്യവസ്ഥകളും', 'விதிமுறைகள் மற்றும் நிபந்தனைகள்'],
  ['Return Policy', 'سياسة الإرجاع', 'वापसी नीति', 'റിട്ടേൺ പോളിസി', 'திருப்பி அனுப்பும் கொள்கை'],
  ['Warranty', 'الضمان', 'वारंटी', 'വാറന്റി', 'உத்தரவாதம்'],
  ['Customer Care', 'خدمة العملاء', 'ग्राहक सेवा', 'കസ്റ്റമർ കെയർ', 'வாடிக்கையாளர் சேவை'],
  ['Authorized Signatory', 'المفوض بالتوقيع', 'अधिकृत हस्ताक्षरकर्ता', 'അംഗീകൃത ഒപ്പ്', 'அங்கீகரிக்கப்பட்ட கையொப்பம்'],
  ['Authorised Signatory', 'المفوض بالتوقيع', 'अधिकृत हस्ताक्षरकर्ता', 'അംഗീകൃത ഒപ്പ്', 'அங்கீகரிக்கப்பட்ட கையொப்பம்'],
  ['Authorised Signature', 'التوقيع المعتمد', 'अधिकृत हस्ताक्षर', 'അംഗീകൃത ഒപ്പ്', 'அங்கீகரிக்கப்பட்ட கையொப்பம்'],
  ['Thank you for your business!', 'شكرًا لتعاملكم معنا!', 'आपके व्यवसाय के लिए धन्यवाद!', 'നിങ്ങളുടെ ബിസിനസിന് നന്ദി!', 'உங்கள் வணிகத்திற்கு நன்றி!'],
  ['Thank you! Visit again.', 'شكرًا لكم! نتشرف بزيارتكم مجددًا.', 'धन्यवाद! फिर पधारें।', 'നന്ദി! വീണ്ടും വരിക.', 'நன்றி! மீண்டும் வருக.'],
  ['Thank you for shopping with us.', 'شكرًا لتسوقكم معنا.', 'हमारे साथ खरीदारी के लिए धन्यवाद।', 'ഞങ്ങളോടൊപ്പം ഷോപ്പിംഗ് ചെയ്തതിന് നന്ദി.', 'எங்களுடன் ஷாப்பிங் செய்ததற்கு நன்றி.'],
];

const norm = (s) => String(s ?? '').trim().replace(/\s+/g, ' ').replace(/[:：]$/, '').trim().toLowerCase();
const DICT = new Map(ROWS.map(([en, ...tr]) => [norm(en), Object.fromEntries(LANGS.map((l, i) => [l, tr[i]]))]));

/** Languages that have bill wording. */
export const BILL_TRANSLATED_LANGUAGES = LANGS;
export const hasBillTranslation = (lang) => LANGS.includes(lang);

/** The other-language wording for an English label, or null. */
export function translateBillLabel(en, lang) {
  if (!lang || lang === 'en') return null;
  return DICT.get(norm(en))?.[lang] || null;
}

/** {mode, lang} for printing: the preference, falling back to English when unusable. */
export function billLanguage(prefs = getBusinessPrefs()) {
  const lang = prefs?.language || 'en';
  const mode = BILL_LANGUAGE_MODES.includes(prefs?.bill_language_mode) ? prefs.bill_language_mode : 'EN';
  if (mode === 'EN' || !hasBillTranslation(lang)) return { mode: 'EN', lang: 'en' };
  return { mode, lang };
}

const escHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

/**
 * A bill label as escaped HTML in the configured language(s).
 *   stack: put the second language under the first (table headings) instead of "A / B".
 */
export function billLabel(en, { stack = false, lang: forced } = {}) {
  const text = String(en ?? '');
  const { mode, lang } = forced || billLanguage();
  const loc = mode === 'EN' ? null : translateBillLabel(text, lang);
  if (!loc) return escHtml(text);
  const dir = RTL.has(lang) ? 'rtl' : 'ltr';
  const locHtml = `<span class="bl-loc" lang="${lang}" dir="${dir}">${escHtml(loc)}</span>`;
  if (mode === 'LOCAL') return locHtml;
  // Keep a trailing colon on the outside: "Date / التاريخ:" rather than "Date: / التاريخ".
  const colon = /[:：]\s*$/.test(text) ? ':' : '';
  const base = colon ? text.replace(/[:：]\s*$/, '') : text;
  return stack
    ? `${escHtml(base)}${colon}<span class="bl-stack">${locHtml}</span>`
    : `${escHtml(base)} / ${locHtml}${colon}`;
}

/** Plain-text variant (document <title>, alt text). */
export function billLabelText(en) {
  const { mode, lang } = billLanguage();
  const loc = mode === 'EN' ? null : translateBillLabel(en, lang);
  if (!loc) return String(en ?? '');
  return mode === 'LOCAL' ? loc : `${en} / ${loc}`;
}

/** Styles both renderers add for the bilingual markup. */
// On a right-to-left page, values typed in English / digits (phone numbers, addresses, item names)
// must keep their own direction — otherwise "+91 90000 11111" prints as "11111 90000 91+".
export const BILL_I18N_CSS = '.bl-loc{unicode-bidi:isolate}.bl-stack{display:block;font-size:0.85em;font-weight:inherit;line-height:1.2}'
  + 'html[dir=rtl] td,html[dir=rtl] .bd-v,html[dir=rtl] .row>span:last-child{unicode-bidi:plaintext}'
  + 'html[dir=rtl] .cust-line,html[dir=rtl] .co-line,html[dir=rtl] .bd-party-name,html[dir=rtl] .foot-block'
  + '{unicode-bidi:plaintext;text-align:right}';

/** <html lang/dir> attributes. An Arabic / Urdu-only bill reads right to left (flip) — except
 *  Bill Designer layouts, whose blocks sit at fixed positions: those keep their designed layout
 *  and only their wording changes. */
export function billHtmlAttrs({ flip = true } = {}) {
  const { mode, lang } = billLanguage();
  if (mode !== 'LOCAL') return 'lang="en"';
  return `lang="${lang}"${flip && RTL.has(lang) ? ' dir="rtl"' : ''}`;
}
