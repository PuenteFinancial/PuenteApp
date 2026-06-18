import { NextRequest, NextResponse } from 'next/server'
import { FX_RATE } from '@/lib/fx'

const FALLBACK: Record<string, number> = {
  MXN: 17.20, PHP: 57.50, GTQ: 7.75, HNL: 24.90,
  DOP: 58.50, COP: 4200, PEN: 3.75, INR: 83.50,
  NGN: 1550, VND: 25200,
}

export async function GET(req: NextRequest) {
  const target = req.nextUrl.searchParams.get('target') || 'MXN'
  try {
    const res = await fetch(`https://wise.com/rates/live?source=USD&target=${target}`, {
      next: { revalidate: 1800 },
    })
    const data = await res.json()
    const rate = data?.value
    if (!rate || typeof rate !== 'number') throw new Error('Bad response')
    return NextResponse.json({ rate, currency: target })
  } catch {
    const fallbackRate = FALLBACK[target] ?? FX_RATE
    return NextResponse.json({ rate: fallbackRate, currency: target, fallback: true })
  }
}
