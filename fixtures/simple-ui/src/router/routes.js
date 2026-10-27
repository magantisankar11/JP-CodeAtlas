import Tabs from 'pages/Tabs.vue'

const routes = [
  { path: '/orders/:id', name: 'order', component: () => import('pages/OrderPage.vue') },
  { path: '/tabs', component: Tabs }
]

export default routes
