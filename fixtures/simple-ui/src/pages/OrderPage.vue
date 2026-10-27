<template>
  <div>
    <button @click="load">Load</button>
    <button @click="remove">Delete</button>
    <OrderList />
  </div>
</template>

<script>
import ShopService from 'src/services/shop-service'
import OrderList from 'components/OrderList.vue'

export default {
  name: 'OrderPage',
  components: { OrderList },
  props: { id: String },
  data () {
    return { order: null }
  },
  methods: {
    load () {
      return ShopService.getOrder(this.id).then((r) => { this.order = r.data })
    },
    remove () {
      return ShopService.deleteOrder(this.id)
    }
  }
}
</script>
