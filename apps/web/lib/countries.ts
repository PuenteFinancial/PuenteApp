export type Country = {
  name: { en: string; es: string }
  currency: string
  inCalc: boolean
  flagColors?: [string, string, string]
}

export const COUNTRIES: Country[] = [
  { name: { en: 'Mexico', es: 'México' },                        currency: 'MXN', inCalc: true,  flagColors: ['#006847', '#fff',    '#ce1126'] },
  { name: { en: 'Philippines', es: 'Filipinas' },                currency: 'PHP', inCalc: true,  flagColors: ['#0038a8', '#fff',    '#ce1126'] },
  { name: { en: 'Guatemala', es: 'Guatemala' },                  currency: 'GTQ', inCalc: true,  flagColors: ['#4997d0', '#fff',    '#4997d0'] },
  { name: { en: 'Honduras', es: 'Honduras' },                    currency: 'HNL', inCalc: true,  flagColors: ['#0073CF', '#fff',    '#0073CF'] },
  { name: { en: 'El Salvador', es: 'El Salvador' },              currency: 'USD', inCalc: false },
  { name: { en: 'Dominican Republic', es: 'Rep. Dominicana' },   currency: 'DOP', inCalc: true,  flagColors: ['#002d62', '#fff',    '#cf142b'] },
  { name: { en: 'Colombia', es: 'Colombia' },                    currency: 'COP', inCalc: true,  flagColors: ['#FCD116', '#003087', '#CE1126'] },
  { name: { en: 'Ecuador', es: 'Ecuador' },                      currency: 'USD', inCalc: false },
  { name: { en: 'Peru', es: 'Perú' },                            currency: 'PEN', inCalc: true,  flagColors: ['#D91023', '#fff',    '#D91023'] },
  { name: { en: 'Venezuela', es: 'Venezuela' },                  currency: 'VES', inCalc: false },
  { name: { en: 'India', es: 'India' },                          currency: 'INR', inCalc: true,  flagColors: ['#FF9933', '#fff',    '#138808'] },
  { name: { en: 'Nigeria', es: 'Nigeria' },                      currency: 'NGN', inCalc: true,  flagColors: ['#008751', '#fff',    '#008751'] },
  { name: { en: 'Vietnam', es: 'Vietnam' },                      currency: 'VND', inCalc: true,  flagColors: ['#DA251D', '#DA251D', '#DA251D'] },
  { name: { en: 'Other', es: 'Otro' },                           currency: '',    inCalc: false },
]
