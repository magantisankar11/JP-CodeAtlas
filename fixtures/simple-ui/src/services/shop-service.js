import axios from 'axios'

const apiBase = () => process.env.JP_API

class ShopService {
  getOrder (orderId) {
    const url = 'api/orders/' + orderId
    return axios.get(apiBase() + url)
  }

  searchOrders (useV2) {
    let url = 'api/orders/search'
    if (useV2) {
      url += '/v2'
    }
    return axios.get(apiBase() + url + '?q=1')
  }

  createOrder (order) {
    return axios.post(`${apiBase()}api/orders`, order)
  }

  deleteOrder (orderId) {
    return axios.delete(apiBase() + `api/orders/${orderId}`)
  }

  // Only POST /api/orders/quote exists: method mismatch
  legacyQuote () {
    return axios.put(apiBase() + 'api/orders/quote')
  }

  // No such endpoint in the backend
  invoices () {
    return axios.get(apiBase() + 'api/invoices')
  }

  // Another service, not the backend
  summary () {
    return axios.post(process.env.AI_API + 'summary', {})
  }

  // URL only known at runtime
  anything (path) {
    return axios.get(apiBase() + path)
  }
}

export default new ShopService()
