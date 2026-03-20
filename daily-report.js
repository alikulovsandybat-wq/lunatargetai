// api/cron/daily-report.js
import { createClient } from '@supabase/supabase-js'
import { isSubscriptionActive } from '../_subscription.js'

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
)

export default async function handler(req, res) {
  if (!['GET', 'POST'].includes(req.method)) return res.status(405).end()

  const secret = process.env.CRON_SECRET
  if (secret) {
    const auth = req.headers.authorization || ''
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : ''
    const querySecret = req.query?.secret
    if (token !== secret && querySecret !== secret) {
      return res.status(401).json({ error: 'Unauthorized' })
    }
  }

  try {
    const tz = process.env.REPORT_TZ || 'Asia/Almaty'
    const dateParts = getYesterdayParts(tz)
    const dateYmd = `${dateParts.year}-${dateParts.month}-${dateParts.day}`
    const dateLabel = `${dateParts.day}.${dateParts.month}.${dateParts.year}`

    // Получаем всех пользователей
    const { data: allUsers, error } = await supabase
      .from('users')
      .select('tg_user_id, fb_access_token, fb_ad_account_id, subscription_active, subscription_until')

    if (error) throw error

    const activeUsers = (allUsers || []).filter(u => isSubscriptionActive(u))
    const results = []

    // 1. Отправляем отчёт каждому активному пользователю
    for (const user of activeUsers) {
      if (!user.fb_access_token || !user.fb_ad_account_id) continue

      const stats = await fetchDailyStats(user, dateYmd)
      if (!stats) continue

      const message = buildUserReportMessage(dateLabel, stats)
      const sent = await sendMessage(user.tg_user_id, message)
      results.push({ tg_user_id: user.tg_user_id, sent })
    }

    // 2. Предупреждаем пользователей об истекающей подписке (за 3 дня)
    const in3Days = new Date()
    in3Days.setDate(in3Days.getDate() + 3)
    const expiringUsers = (allUsers || []).filter(u => {
      if (!u.subscription_until || !u.subscription_active) return false
      const until = new Date(u.subscription_until)
      return until <= in3Days && until > new Date()
    })

    for (const user of expiringUsers) {
      const until = new Date(user.subscription_until)
      const daysLeft = Math.ceil((until - new Date()) / (1000 * 60 * 60 * 24))
      await sendMessage(user.tg_user_id,
        `⚠️ Ваша подписка Luna Ads истекает через ${daysLeft} дн.\n\n` +
        `Чтобы не потерять доступ — продлите подписку:\n` +
        `👉 https://t.me/marketologluna_bot`
      )
    }

    // 3. Отправляем твой личный отчёт владельца
    const ownerChatId = process.env.OWNER_TG_ID
    if (ownerChatId) {
      // Считаем общую статистику
      const totalUsers = (allUsers || []).length
      const totalActive = activeUsers.length

      // Считаем новых пользователей за вчера
      const { count: newUsersCount } = await supabase
        .from('users')
        .select('*', { count: 'exact', head: true })
        .gte('created_at', `${dateYmd}T00:00:00`)
        .lte('created_at', `${dateYmd}T23:59:59`)

      // Считаем подписки истекающие в ближайшие 3 дня
      const expiringSoon = expiringUsers.length

      // Считаем подписки истекшие сегодня (отключённые)
      const today = new Date().toISOString().split('T')[0]
      const { count: expiredToday } = await supabase
        .from('users')
        .select('*', { count: 'exact', head: true })
        .eq('subscription_active', false)
        .gte('subscription_until', `${today}T00:00:00`)
        .lte('subscription_until', `${today}T23:59:59`)

      const ownerMessage = buildOwnerReportMessage({
        dateLabel,
        totalUsers,
        totalActive,
        newUsers: newUsersCount || 0,
        expiringSoon,
        expiredToday: expiredToday || 0,
        reportsSent: results.length
      })

      await sendMessage(ownerChatId, ownerMessage)
    }

    return res.json({
      ok: true,
      date: dateYmd,
      userReportsSent: results.length,
      subscriptionWarnings: expiringUsers.length
    })

  } catch (error) {
    console.error('Daily report error:', error)
    return res.status(500).json({ error: 'Daily report error' })
  }
}

// ─── СООБЩЕНИЕ ДЛЯ ПОЛЬЗОВАТЕЛЯ ───────────────────────────────────────────

function buildUserReportMessage(dateLabel, stats) {
  const spend = formatMoney(stats.spend, stats.currency)
  const cpl = stats.leads > 0 ? formatMoney(stats.cpl, stats.currency) : '—'
  const impressions = formatNumber(stats.impressions)

  const lines = [
    `📊 Отчёт по рекламе за ${dateLabel}`,
    ``,
    `💰 Потрачено: ${spend}`,
    `👁 Показы: ${impressions}`,
    `🎯 Лиды: ${stats.leads}`,
    `📉 Цена за лид: ${cpl}`,
  ]

  if (stats.leads === 0 && stats.spend === 0) {
    lines.push(``, `ℹ️ Вчера рекламные кампании не запускались.`)
  } else if (stats.leads === 0) {
    lines.push(``, `💡 Лидов пока нет. Попробуйте скорректировать аудиторию.`)
  } else {
    lines.push(``, `✅ Данные получены из Facebook Ads.`)
  }

  lines.push(``, `🚀 Управляйте рекламой: @marketologluna_bot`)

  return lines.join('\n')
}

// ─── СООБЩЕНИЕ ДЛЯ ВЛАДЕЛЬЦА ──────────────────────────────────────────────

function buildOwnerReportMessage({ dateLabel, totalUsers, totalActive, newUsers, expiringSoon, expiredToday, reportsSent }) {
  return [
    `🌙 Luna Ads — Отчёт владельца`,
    `📅 ${dateLabel}`,
    ``,
    `👥 Всего пользователей: ${totalUsers}`,
    `✅ Активных подписок: ${totalActive}`,
    `🆕 Новых за вчера: ${newUsers}`,
    ``,
    `⚠️ Истекает через 3 дня: ${expiringSoon}`,
    `❌ Отключено сегодня: ${expiredToday}`,
    ``,
    `📨 Отчётов отправлено пользователям: ${reportsSent}`,
  ].join('\n')
}

// ─── ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ──────────────────────────────────────────────

function getYesterdayParts(timeZone) {
  const nowTz = new Date(new Date().toLocaleString('en-US', { timeZone }))
  const yesterday = new Date(nowTz)
  yesterday.setDate(yesterday.getDate() - 1)
  return getDatePartsInTz(yesterday, timeZone)
}

function getDatePartsInTz(date, timeZone) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  })
  const parts = formatter.formatToParts(date)
  const map = {}
  for (const part of parts) {
    if (part.type !== 'literal') map[part.type] = part.value
  }
  return map
}

async function fetchDailyStats(user, dateYmd) {
  try {
    const url = `https://graph.facebook.com/v18.0/${user.fb_ad_account_id}/insights?` + new URLSearchParams({
      fields: 'spend,impressions,actions,currency',
      time_range: JSON.stringify({ since: dateYmd, until: dateYmd }),
      access_token: user.fb_access_token
    })

    const res = await fetch(url)
    const data = await res.json()

    if (!res.ok || data?.error) {
      console.warn('FB stats error:', data?.error || data)
      return null
    }

    const insight = data.data?.[0] || {}
    const leads = insight.actions?.find(a => a.action_type === 'lead')?.value || 0
    const spend = parseFloat(insight.spend || 0)
    const impressions = parseInt(insight.impressions || 0)
    const cpl = leads > 0 ? (spend / leads) : 0

    return {
      spend,
      leads: parseInt(leads),
      cpl,
      impressions: Number.isNaN(impressions) ? 0 : impressions,
      currency: insight.currency || '$'
    }
  } catch (error) {
    console.warn('FB stats exception:', error)
    return null
  }
}

function formatMoney(value, currency) {
  const amount = Number.isFinite(value) ? value : 0
  return `${amount.toFixed(2)} ${currency}`
}

function formatNumber(value) {
  if (!value) return '0'
  return value.toLocaleString('ru-RU')
}

async function sendMessage(chatId, text) {
  try {
    const res = await fetch(`https://api.telegram.org/bot${process.env.TG_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text })
    })
    return res.ok
  } catch (error) {
    console.warn('Telegram send error:', error)
    return false
  }
}
