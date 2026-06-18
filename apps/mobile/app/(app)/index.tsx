import { View, Text } from 'react-native'
import { useTranslation } from 'react-i18next'

export default function Dashboard() {
  const { t } = useTranslation()
  return (
    <View className="flex-1 bg-white px-6 pt-12">
      <Text className="text-2xl font-bold text-gray-900">{t('dashboard.title')}</Text>
    </View>
  )
}
