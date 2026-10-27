import { describe, it, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import OrderPage from 'src/pages/OrderPage.vue'

vi.mock('src/services/shop-service', () => ({ default: { getOrder: vi.fn(() => Promise.resolve({ data: {} })) } }))

describe('OrderPage', () => {
  it('renders', () => {
    expect(mount(OrderPage, { props: { id: '1' } }).exists()).toBe(true)
  })
})
