import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { test } from 'node:test'
import { DICTIONARY, dateLocale, hostText, installLocale, language, t } from '../src/client/i18n.js'

function fakeLocale(active) {
  const dicts = new Map()
  const languages = new Map()
  return {
    register: (ns, locale, dict) => { dicts.set(`${ns}:${locale}`, dict); return () => dicts.delete(`${ns}:${locale}`) },
    bind: ns => (key, params) => {
      const text = dicts.get(`${ns}:${active}`)?.[key] ?? key
      return params ? text.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match)) : text
    },
    addLanguage: input => { languages.set(input.id, input); return () => languages.delete(input.id) },
    getLocale: () => ({ active }),
    languages,
  }
}

test('every literal the client translates has an entry in every dictionary', () => {
  const dir = new URL('../src/client/', import.meta.url)
  const missing = []
  for (const name of readdirSync(dir).filter(file => file.endsWith('.js'))) {
    const text = readFileSync(new URL(name, dir), 'utf8')
    for (const match of text.matchAll(/\bt\(\s*(['"])((?:\\.|(?!\1).)*)\1/g)) {
      const key = match[2].replace(/\\'/g, "'")
      for (const [locale, dict] of Object.entries(DICTIONARY)) {
        if (!Object.hasOwn(dict, key)) missing.push(`${locale} ${name}: ${key}`)
      }
    }
  }
  assert.deepEqual(missing, [])
})

test('copy follows the DSH language and stays English without a locale service', () => {
  assert.equal(t('Message {name}', { name: 'Chief' }), 'Message Chief')
  assert.equal(language(), 'en')
  const off = installLocale(fakeLocale('zh'))
  try {
    assert.equal(language(), 'zh')
    assert.equal(t('Message {name}', { name: 'Chief' }), '给 Chief 发消息')
    assert.equal(t('Model'), '模型')
    assert.equal(hostText('A Bot named Writer already exists'), '已经有叫 Writer 的 Bot 了')
    assert.equal(hostText('The team needs at least one Main Bot'), '团队至少要有一个主 Bot')
    assert.equal(hostText('Something new'), 'Something new')
    // Whole memory messages, not only their first words, become Chinese.
    assert.equal(hostText('An entry holds at most 300 characters; this one has 301. Keep one fact per entry, or save the details as several entries in a topic.'), '一条记忆最多 300 个字符，这条有 301 个')
    assert.equal(hostText("Writer's memory's MEMORY.md would have 4100 of its 4000 characters. Make room first: move details into a topic."), '主记忆会超过 4000 个字符的上限，请先删掉一些')
    assert.equal(hostText('There is no entry 9.'), '没有第 9 条')
  } finally {
    off()
  }
  assert.equal(t('Model'), 'Model')
  assert.equal(hostText('A Bot named Writer already exists'), 'A Bot named Writer already exists')
})

test('Vietnamese copy is registered and selectable as a language', () => {
  const locale = fakeLocale('vi')
  const off = installLocale(locale)
  try {
    assert.equal(locale.languages.get('vi')?.label, 'Tiếng Việt')
    assert.equal(language(), 'vi')
    assert.equal(dateLocale(), 'vi-VN')
    assert.equal(t('Message {name}', { name: 'Chief' }), 'Nhắn tin cho Chief')
    assert.equal(t('Model'), 'Model')
    assert.equal(hostText('A Bot named Writer already exists'), 'Đã có Bot tên Writer')
    assert.equal(hostText('The team needs at least one Main Bot'), 'Đội cần ít nhất một Bot chính')
    assert.equal(hostText('Something new'), 'Something new')
    assert.equal(hostText('An entry holds at most 300 characters; this one has 301. Keep one fact per entry, or save the details as several entries in a topic.'), 'Một mục tối đa 300 ký tự, mục này có 301')
    assert.equal(hostText("Writer's memory's MEMORY.md would have 4100 of its 4000 characters. Make room first: move details into a topic."), 'Bộ nhớ chính sẽ vượt giới hạn 4000 ký tự, hãy xóa bớt trước')
    assert.equal(hostText('There is no entry 9.'), 'Không có mục số 9')
  } finally {
    off()
  }
  assert.equal(t('Message {name}', { name: 'Chief' }), 'Message Chief')
})
