<template>
  <ul>
    <li v-for="o in orders" :key="o.id">{{ o.id }}</li>
  </ul>
  <button @click="refresh">Refresh</button>
</template>

<script setup>
import { ref } from 'vue'
import ShopService from 'src/services/shop-service'

const orders = ref([])

function refresh () {
  return ShopService.searchOrders(true).then((r) => { orders.value = r.data })
}
</script>
