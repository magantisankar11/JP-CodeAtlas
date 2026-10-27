<template>
  <component :is="current" />
</template>

<script>
import OrderList from 'components/OrderList.vue'
import Empty from 'components/Empty.vue'

export default {
  name: 'Tabs',
  components: { OrderList, Empty },
  data () {
    return { current: 'Empty' }
  }
}
</script>
